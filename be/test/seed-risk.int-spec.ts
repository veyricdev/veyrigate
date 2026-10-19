import { jest } from '@jest/globals';
import mongoose, { type Connection, type Model } from 'mongoose';
import { verifyPassword } from '../src/common/crypto/crypto.util';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { seedBootstrap, type AdminSeedConfig } from '../src/database/seed';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { adminResourceIdentifier } from '../src/modules/oauth/token/token.service';

/**
 * Run 30 QA (tester) — risk matrix for `db:seed` (B6.4) beyond the dev-written spec:
 * concurrency (two seeds at once), ISSUER change between runs, and the DEBT-137 invariant
 * "a client holding the admin resource is confidential with no pre-grant secret" across the
 * seed path (resource `admin` re-pointed by the seed).
 */
const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-seedrisk-${Date.now()}?directConnection=true`;
const ISSUER = 'http://localhost:4000';
const ISSUER_B = 'http://localhost:4100';
// Test-only values for a throwaway int DB.
const ADMIN: AdminSeedConfig = { email: 'risk-admin@example.com', password: 'risk-admin-pass-1' };
const COLLECTIONS = [
  'tenants',
  'resources',
  'users',
  'usertenants',
  'clients',
  'clientcredentials',
] as const;

describe('db:seed risk matrix (run 30 QA)', () => {
  let connection: Connection;
  let creds: Model<Record<string, unknown>>;

  const counts = async (): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const c of COLLECTIONS) out[c] = await connection.collection(c).countDocuments({});
    return out;
  };

  beforeAll(async () => {
    connection = await mongoose.createConnection(MONGO_URI, { autoIndex: false }).asPromise();
    for (const { name, schema } of MODELS) connection.model(name, schema);
    await syncAllIndexes(connection);
    creds = connection.model<Record<string, unknown>>('ClientCredential');
  }, 30_000);

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const c of COLLECTIONS) await connection.collection(c).deleteMany({});
  });

  afterAll(async () => {
    await connection.dropDatabase();
    await connection.close();
  });

  it('State/concurrent: two seeds at once on an empty DB => no duplicated document; every returned secret works', async () => {
    for (let round = 0; round < 5; round++) {
      const results = await Promise.allSettled([
        seedBootstrap(connection, ADMIN, ISSUER, 'test'),
        seedBootstrap(connection, ADMIN, ISSUER, 'test'),
      ]);
      const c = await counts();
      expect({ ...c, clientcredentials: undefined }).toEqual({
        tenants: 1,
        resources: 3,
        users: 1,
        usertenants: 1,
        clients: 2,
        clientcredentials: undefined,
      });
      // Accepted by the fold (DEBT-164): up to 2 secrets. Never more, and never a printed secret
      // that does not authenticate.
      expect(c.clientcredentials).toBeGreaterThanOrEqual(1);
      expect(c.clientcredentials).toBeLessThanOrEqual(2);
      const live = await creds.find({ clientId: 'fe-admin', revokedAt: null }).lean().exec();
      for (const r of results) {
        if (r.status !== 'fulfilled' || !r.value.feAdminSecret) continue;
        const ok = await Promise.all(
          live.map((d) => verifyPassword(d.secretHash as string, r.value.feAdminSecret!)),
        );
        expect(ok).toContain(true);
      }
      expect(results.some((r) => r.status === 'fulfilled' && r.value.feAdminSecret)).toBe(true);
      const member = await connection
        .collection('usertenants')
        .findOne({ tenantId: DEFAULT_TENANT_ID });
      expect(member?.roles).toEqual(['super_admin']);
      // Record the outcome mix for the report (rejections are tolerated, duplicates are not).
      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      for (const r of rejected) {
        // A loser may only fail on the credential version race (E11000), never elsewhere.
        expect(String((r.reason as Error).message)).toMatch(/E11000|duplicate/i);
      }
      for (const name of COLLECTIONS) await connection.collection(name).deleteMany({});
    }
  }, 60_000);

  it('ISSUER change between runs => refused before any write (admin never re-pointed, DEBT-173); fe-admin secret not rotated', async () => {
    const first = await seedBootstrap(connection, ADMIN, ISSUER, 'test');
    expect(first.feAdminSecret).toBeDefined();
    const cred1 = await creds.findOne({ clientId: 'fe-admin' }).lean().exec();
    const after1 = await counts();

    await expect(seedBootstrap(connection, ADMIN, ISSUER_B, 'test')).rejects.toThrow(
      /refusing to point resource 'admin'/,
    );
    expect(await counts()).toEqual(after1);
    const admin = await connection.collection('resources').findOne({ resourceId: 'admin' });
    expect(admin?.identifier).toBe(adminResourceIdentifier(ISSUER));
    const demo = await connection.collection('resources').findOne({ resourceId: 'demo' });
    expect(demo?.identifier).toBe(`${ISSUER}/demo/`);
    const cred2 = await creds.findOne({ clientId: 'fe-admin' }).lean().exec();
    expect(cred2?.secretHash).toBe(cred1?.secretHash);
  });

  it('Input/env: invalid ISSUER (not an absolute URI) => throws before any write', async () => {
    await expect(seedBootstrap(connection, ADMIN, 'not a uri', 'test')).rejects.toThrow();
    expect(Object.values(await counts()).every((n) => n === 0)).toBe(true);
  });

  it('DEBT-137 via seed: resource `admin` re-pointed to the admin identifier must not make a PUBLIC client admin-capable', async () => {
    // Pre-existing state reachable through the API: resource `admin` registered (or seeded under
    // another ISSUER) with a NON-admin identifier, so tenant_admin may attach it to a public SPA.
    await connection.collection('resources').insertOne({
      resourceId: 'admin',
      identifier: `${ISSUER}/legacy-api/`,
      scopes: [],
    });
    await connection.collection('clients').insertOne({
      clientId: 'ta-public-spa',
      clientType: 'public',
      tokenEndpointAuthMethod: 'none',
      grantTypes: ['authorization_code'],
      redirectUris: ['http://localhost:5174/cb'],
      postLogoutRedirectUris: [],
      allowedCorsOrigins: [],
      allowedResources: ['admin'],
      scopes: ['openid'],
      tenantId: DEFAULT_TENANT_ID,
    });

    let threw = false;
    await seedBootstrap(connection, ADMIN, ISSUER, 'test').catch(() => {
      threw = true;
    });
    const admin = await connection
      .collection('resources')
      .findOne({ identifier: adminResourceIdentifier(ISSUER) });
    const spa = await connection.collection('clients').findOne({ clientId: 'ta-public-spa' });
    const spaIsAdminCapable =
      admin != null && (spa?.allowedResources as string[]).includes(admin.resourceId as string);
    // Invariant (DEBT-137 rule A): either the seed refuses, or the public client is not admin-capable.
    expect({ threw, spaIsAdminCapable }).not.toEqual({ threw: false, spaIsAdminCapable: true });
  });

  it('DEBT-137 via seed: a CONFIDENTIAL client whose secret predates the re-point keeps no live pre-grant secret', async () => {
    await connection.collection('resources').insertOne({
      resourceId: 'admin',
      identifier: `${ISSUER}/legacy-api/`,
      scopes: [],
    });
    await connection.collection('clients').insertOne({
      clientId: 'ta-bff',
      clientType: 'confidential',
      tokenEndpointAuthMethod: 'client_secret_basic',
      grantTypes: ['authorization_code'],
      redirectUris: ['http://localhost:5174/cb'],
      postLogoutRedirectUris: [],
      allowedCorsOrigins: [],
      allowedResources: ['admin'],
      scopes: ['openid'],
      tenantId: DEFAULT_TENANT_ID,
    });
    await connection.collection('clientcredentials').insertOne({
      clientId: 'ta-bff',
      version: 1,
      secretHash: 'x',
      createdAt: new Date(),
      revokedAt: null,
    });

    let threw = false;
    await seedBootstrap(connection, ADMIN, ISSUER, 'test').catch(() => {
      threw = true;
    });
    const admin = await connection
      .collection('resources')
      .findOne({ identifier: adminResourceIdentifier(ISSUER) });
    const bff = await connection.collection('clients').findOne({ clientId: 'ta-bff' });
    const bffIsAdminCapable =
      admin != null && (bff?.allowedResources as string[]).includes(admin.resourceId as string);
    const liveOld = await creds.countDocuments({ clientId: 'ta-bff', revokedAt: null });
    expect({ threw, bffAdminWithLiveOldSecret: bffIsAdminCapable && liveOld > 0 }).not.toEqual({
      threw: false,
      bffAdminWithLiveOldSecret: true,
    });
  });
});

/**
 * Run 31 (DEBT-176): the seed ensures the unique indexes itself (`createIndexes`) before any write,
 * so two concurrent runs on a DB that was NEVER synced still converge (no duplicated document).
 */
describe('db:seed on a never-synced DB (DEBT-176)', () => {
  const URI = `mongodb://localhost:27117/vg-int-seednoidx-${Date.now()}?directConnection=true`;
  let a: Connection;
  let b: Connection;
  const open = async () => {
    const c = await mongoose.createConnection(URI, { autoIndex: false }).asPromise();
    for (const { name, schema } of MODELS) c.model(name, schema);
    return c;
  };
  const counts = async (): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const c of COLLECTIONS) out[c] = await a.collection(c).countDocuments({});
    return out;
  };

  beforeAll(async () => {
    a = await open();
    b = await open();
  }, 30_000);

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await a.dropDatabase();
    await a.close();
    await b.close();
  });

  it('two seeds at once (2 connections), 10 rounds, DB dropped (no index) each round => exactly one of each document', async () => {
    const bad: number[] = [];
    for (let round = 0; round < 10; round++) {
      await a.dropDatabase();
      expect(await a.db!.listCollections().toArray()).toHaveLength(0);
      const results = await Promise.allSettled([
        seedBootstrap(a, ADMIN, ISSUER, 'test'),
        seedBootstrap(b, ADMIN, ISSUER, 'test'),
      ]);
      const c = await counts();
      const ok =
        c.tenants === 1 &&
        c.resources === 3 &&
        c.users === 1 &&
        c.usertenants === 1 &&
        c.clients === 2 &&
        (await a.collection('resources').countDocuments({ resourceId: 'admin' })) === 1 &&
        (await a.collection('clients').countDocuments({ clientId: 'fe-admin' })) === 1 &&
        (await a.collection('clients').countDocuments({ clientId: 'fe-sso-test' })) === 1;
      if (!ok) bad.push(round);
      // DEBT-164 (out of scope): 1-2 fe-admin credentials; a loser may fail on that E11000 only.
      expect(c.clientcredentials).toBeGreaterThanOrEqual(1);
      expect(c.clientcredentials).toBeLessThanOrEqual(2);
      for (const r of results) {
        if (r.status === 'rejected') {
          expect(String((r.reason as Error).message)).toMatch(/E11000|duplicate/i);
        }
      }
    }
    console.info(`DEBT-176: ${bad.length}/10 rounds with a duplicated document`);
    expect(bad).toEqual([]);
  }, 120_000);

  it('data already duplicated (no index, 2 users with the same email) => throws before any write, 0 new documents', async () => {
    await a.dropDatabase();
    const dup = { email: ADMIN.email, failedLoginCount: 0 };
    await a.collection('users').insertMany([{ ...dup }, { ...dup }]);
    const err = await seedBootstrap(a, ADMIN, ISSUER, 'test').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/seed: ensuring the User indexes failed/);
    expect((err as Error).message).toMatch(/db:sync-indexes/);
    expect((err as Error).message).not.toContain(ADMIN.email); // no PII echoed from E11000
    const c = await counts();
    expect(c).toEqual({ ...Object.fromEntries(COLLECTIONS.map((n) => [n, 0])), users: 2 });
  });

  // Run 31 QA (DEBT-178): deterministic guard of "the seed ensures the indexes itself". The race
  // test above is RED 0/10 without `createIndexes` (in-process timing); this one is RED 100%.
  it('DEBT-178: after seedBootstrap on a never-synced DB (autoIndex:false), EVERY schema index of EVERY model exists, unique ones unique', async () => {
    await a.dropDatabase();
    await seedBootstrap(a, ADMIN, ISSUER, 'test');
    const missing: string[] = [];
    let checked = 0;
    for (const { name, schema } of MODELS) {
      // A collection the seed never created has no index at all (NamespaceNotFound => []).
      const actual = await a
        .model(name)
        .collection.listIndexes()
        .toArray()
        .catch((e: { code?: number }) => {
          if (e.code === 26) return [];
          throw e;
        });
      for (const [fields, options] of schema.indexes()) {
        checked++;
        const key = JSON.stringify(fields);
        const found = actual.find((i) => JSON.stringify(i.key) === key);
        if (!found) missing.push(`${name} ${key}`);
        else if ((options as { unique?: boolean }).unique && found.unique !== true) {
          missing.push(`${name} ${key} (not unique)`);
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
    expect(missing).toEqual([]);
    // The keys the seed's own upserts depend on, named explicitly.
    const uniq = async (coll: string, field: string) =>
      (await a.collection(coll).listIndexes().toArray()).some(
        (i) => i.unique === true && Object.keys(i.key as object).join() === field,
      );
    expect(await uniq('users', 'email')).toBe(true);
    expect(await uniq('clients', 'clientId')).toBe(true);
    expect(await uniq('tenants', 'id')).toBe(true);
    expect(await uniq('resources', 'identifier')).toBe(true);
    expect(await uniq('usertenants', 'userId,tenantId')).toBe(true);
    expect(await uniq('clientcredentials', 'clientId,version')).toBe(true);
  });
});
