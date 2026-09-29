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
    Client: [{ key: { clientId: 1 }, unique: true }],
    ClientCredential: [{ key: { clientId: 1, version: 1 } }],
    Resource: [{ key: { identifier: 1 }, unique: true }],
    Consent: [{ key: { userId: 1, clientId: 1 }, unique: true }],
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
});
