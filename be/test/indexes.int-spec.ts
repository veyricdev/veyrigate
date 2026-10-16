import mongoose, { type Connection, Types } from 'mongoose';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';

const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-${Date.now()}?directConnection=true`;

type IndexInfo = { key: Record<string, number>; unique?: boolean; expireAfterSeconds?: number };

/** Expected indexes per model, spec §10 (+ A2: AuditLog userId → actorId). */
const EXPECTED: Record<string, { key: Record<string, number>; unique?: boolean; ttl?: number }[]> =
  {
    User: [{ key: { email: 1 }, unique: true }],
    FederatedIdentity: [{ key: { provider: 1, providerId: 1 }, unique: true }],
    Tenant: [{ key: { id: 1 }, unique: true }],
    UserTenant: [{ key: { userId: 1, tenantId: 1 }, unique: true }],
    Client: [
      { key: { clientId: 1 }, unique: true },
      // DEBT-020: supports `isOriginRegisteredForAnyClient` (CORS preflight / metadata) lookups.
      { key: { allowedCorsOrigins: 1 } },
      // B6.3a: tenant-scoped admin list/get paged by clientId.
      { key: { tenantId: 1, clientId: 1 } },
    ],
    ClientCredential: [{ key: { clientId: 1, version: 1 }, unique: true }],
    Resource: [{ key: { identifier: 1 }, unique: true }],
    Consent: [{ key: { userId: 1, clientId: 1, resource: 1 }, unique: true }],
    RefreshToken: [
      { key: { tokenHash: 1 }, unique: true },
      { key: { userId: 1, clientId: 1 } },
      { key: { familyId: 1 } },
      { key: { expiresAt: 1 }, ttl: 0 },
    ],
    PasswordResetToken: [
      { key: { tokenHash: 1 }, unique: true },
      { key: { expiresAt: 1 }, ttl: 0 },
    ],
    EmailVerificationToken: [
      { key: { tokenHash: 1 }, unique: true },
      { key: { expiresAt: 1 }, ttl: 0 },
    ],
    AuditLog: [
      { key: { timestamp: 1 } },
      { key: { actorId: 1 } },
      { key: { clientId: 1 } },
      { key: { action: 1 } },
    ],
  };

describe('Mongo indexes after explicit sync (B1.6, spec §10)', () => {
  let conn: Connection;

  beforeAll(async () => {
    conn = await mongoose
      .createConnection(MONGO_URI, { autoIndex: false, serverSelectionTimeoutMS: 5000 })
      .asPromise();
    await syncAllIndexes(conn);
  }, 30_000); // creating 12 collections + indexes can exceed Jest's 5s default

  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });

  it.each(Object.keys(EXPECTED))('%s has exactly the §10 indexes (+ _id)', async (name) => {
    const indexes = (await conn.models[name].collection.indexes()) as IndexInfo[];
    const actual = indexes
      .filter((i) => !('_id' in i.key))
      .map((i) => ({ key: i.key, unique: !!i.unique, ttl: i.expireAfterSeconds }));
    const expected = EXPECTED[name].map((e) => ({ key: e.key, unique: !!e.unique, ttl: e.ttl }));
    expect(actual).toHaveLength(expected.length);
    expect(actual).toEqual(expect.arrayContaining(expected));
  });

  it('sync is idempotent (second run drops nothing)', async () => {
    const dropped = await syncAllIndexes(conn);
    expect(Object.values(dropped).flat()).toEqual([]);
  });

  it('duplicate unique values are rejected with E11000 (User.email lowercased, RefreshToken.tokenHash)', async () => {
    const User = conn.models.User;
    await User.create({ email: 'Dup@Example.com' });
    await expect(User.create({ email: 'dup@example.com' })).rejects.toMatchObject({ code: 11000 });

    const RT = conn.models.RefreshToken;
    const doc = {
      tokenHash: 'h1',
      familyId: 'f1',
      userId: new Types.ObjectId(),
      clientId: 'c1',
      resource: 'https://api.example/',
      expiresAt: new Date(Date.now() + 60_000),
    };
    await RT.create(doc);
    await expect(RT.create({ ...doc, familyId: 'f2' })).rejects.toMatchObject({ code: 11000 });
  });

  it('ClientCredential {clientId, version} is unique (DEBT-021)', async () => {
    const CC = conn.models.ClientCredential;
    await CC.create({ clientId: 'cc-dup', secretHash: 'h', version: 1 });
    await expect(
      CC.create({ clientId: 'cc-dup', secretHash: 'h2', version: 1 }),
    ).rejects.toMatchObject({ code: 11000 });
    // A different version for the same client is fine.
    await expect(
      CC.create({ clientId: 'cc-dup', secretHash: 'h3', version: 2 }),
    ).resolves.toBeDefined();
  });
});

/**
 * DEBT-028: an environment deployed before Q1 (user × client × resource) carries the OLD unique
 * index `{userId:1, clientId:1}` on `consents`. A deploy must run `syncAllIndexes` so the old index
 * is DROPPED and the new `{userId:1, clientId:1, resource:1}` unique index is built. These tests
 * simulate that upgrade on a FRESH database (the suite above asserts the clean-slate shape).
 */
describe('Consent index migration M3→M4 (DEBT-028)', () => {
  const OLD_INDEX = 'userId_1_clientId_1';
  let conn: Connection;

  beforeAll(async () => {
    // Insert a distinct DB-name suffix BEFORE the query string so `?directConnection=true` stays
    // intact (appending to the whole URI would corrupt the query).
    const migrationUri = MONGO_URI.replace(/(\/[^/?]+)(\?|$)/, '$1-consent-migration$2');
    conn = await mongoose
      .createConnection(migrationUri, {
        autoIndex: false,
        serverSelectionTimeoutMS: 5000,
      })
      .asPromise();
  }, 30_000);

  afterEach(async () => {
    await conn.dropDatabase();
  });

  afterAll(async () => {
    await conn.close();
  });

  it('syncAllIndexes drops the old {userId,clientId} unique index and builds {userId,clientId,resource}', async () => {
    // Simulate the already-deployed state: create the OLD unique index before syncing.
    await conn.db!.collection('consents').createIndex({ userId: 1, clientId: 1 }, { unique: true });

    const dropped = await syncAllIndexes(conn);
    expect(dropped.Consent).toContain(OLD_INDEX);

    const indexes = (await conn.models.Consent.collection.indexes()) as IndexInfo[];
    const nonId = indexes
      .filter((i) => !('_id' in i.key))
      .map((i) => ({ key: i.key, unique: !!i.unique }));
    expect(nonId).toEqual([{ key: { userId: 1, clientId: 1, resource: 1 }, unique: true }]);
    // The old index is gone.
    expect(
      nonId.some((i) => i.key.userId === 1 && i.key.clientId === 1 && !('resource' in i.key)),
    ).toBe(false);
  });

  it('fails closed (no data deleted) when legacy data violates the NEW unique key', async () => {
    // Legacy collection with NO unique index (e.g. one hand-dropped during ops) carrying two docs
    // that collide under the new key {userId,clientId,resource} (same triple). Building the new
    // unique index must FAIL (E11000) and MUST NOT delete the operator's data.
    const userId = new Types.ObjectId();
    await conn.db!.collection('consents').insertMany([
      { userId, clientId: 'c1', resource: '', grantedScopes: ['openid'] },
      { userId, clientId: 'c1', resource: '', grantedScopes: ['profile'] },
    ]);

    await expect(syncAllIndexes(conn)).rejects.toMatchObject({ code: 11000 });
    // No user data was removed by the failed build (fail-closed; operator cleans up per runbook).
    const count = await conn.db!.collection('consents').countDocuments({ userId });
    expect(count).toBe(2);
    // DEBT-061: mongoose 9 drops the old index BEFORE building the new one, so after a failed build
    // `consents` has NO unique index left (only `_id_`). This pins the runbook §2b recovery note
    // ("consents không còn unique index nào") to the real mongoose behaviour — if a future mongoose
    // reorders drop/build, this assertion goes red and the runbook must be revisited.
    const indexes = (await conn.db!.collection('consents').indexes()) as IndexInfo[];
    const nonId = indexes.filter((i) => !('_id' in i.key));
    expect(nonId.some((i) => i.unique)).toBe(false);
  });
});
