import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import mongoose, { type Connection, Types } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { SessionService } from '../src/modules/sessions/session.service';
import {
  authorizeCode,
  bootFullApp,
  FLOW_ADMIN_AUD,
  FLOW_REDIRECT,
  formPost,
  seedFlowClient,
  type FullApp,
  type InjectResponse,
} from './full-app';
import { INT_SETUP_TIMEOUT_MS, settled, withDbSuffix } from './int-hooks';
import { seedConsent, seedOAuthUser } from './oauth-fixtures';

/**
 * Run 71 tester (DEBT-344 + DEBT-498), independent of the dev spec: a wide IP corpus over real HTTP
 * (6to4, NAT64, Teredo, zone, upper-case mapped, junk), negative actors, demotion AND promotion on
 * the same token, TTL per env on boot, the repo's `db:sync-indexes` CLI (dist) on a legacy DB, and
 * boot failure on bad env.
 */
const ADMIN_SCOPE = 'openid admin.read admin.write offline_access';

// [stored ip, expected masked (undefined = key absent), substrings that must NEVER reach a non-super viewer]
const CORPUS: [string | undefined, string | undefined, string[]][] = [
  ['203.0.113.77', '203.0.113.0/24', ['203.0.113.77']],
  ['2001:db8:abcd:12::1', '2001:db8:abcd::/48', ['2001:db8:abcd:12', ':12::1']],
  ['::ffff:198.51.100.23', '198.51.100.0/24', ['198.51.100.23', '::ffff']],
  ['::FFFF:198.51.100.24', '198.51.100.0/24', ['198.51.100.24', '::FFFF']],
  ['::ffff:c633:6419', '198.51.100.0/24', ['c633:6419', '198.51.100.25']],
  // 6to4 (DEBT-498): 2002:cb00:714e:: embeds 203.0.113.78
  ['2002:cb00:714e::1', '203.0.113.0/24', ['2002:cb00:714e', 'cb00:714e', '203.0.113.78']],
  // NAT64 64:ff9b::cb00:714f embeds 203.0.113.79 in the low 32 bits
  ['64:ff9b::cb00:714f', '64:ff9b::/48', ['cb00:714f', '203.0.113.79']],
  // Teredo: client ip obfuscated in the low 32 bits, port in hextet 6
  ['2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:0:4136::/48', ['e378', '63bf', '3fff:fdd2']],
  ['fe80::1234:5678%eth0', 'fe80::/48', ['1234:5678', '%eth0', 'eth0']],
  ['fe80::abcd:ef01%25', 'fe80::/48', ['abcd:ef01']],
  ['127.1', undefined, ['127.1']],
  ['0x7f.0.0.1', undefined, ['0x7f']],
  ['10.11.12.13/8', undefined, ['10.11.12.13']],
  ['r71t-garbage<script>', undefined, ['r71t-garbage', '<script>']],
  ['203.0.113.80, 10.9.8.7', undefined, ['203.0.113.80', '10.9.8.7']],
  ['', undefined, []],
  ['   ', undefined, []],
  [undefined, undefined, []],
];
const UA = (n: number) => `R71T-UA-${n}-Mozilla/5.0 (X11; Tester)`;

describe('run 71 tester: audit PII per viewer over real HTTP', () => {
  let full: FullApp;
  let bff: { clientId: string; secret: string };
  const actorId = `r71t-actor-${randomUUID()}`;
  const ids: Record<string, string> = {};
  const at: Record<string, string> = {};
  const eventIds: string[] = [];

  const boot = async (): Promise<void> => {
    full = await bootFullApp({ name: 'r71t' }); // AUDIT_RETENTION_DAYS unset ⇒ 180
    bff = await seedFlowClient(full);
    for (const [who, roles] of [
      ['tenant', ['tenant_admin']],
      ['super', ['super_admin']],
      ['demoted', ['super_admin']],
      ['promoted', ['tenant_admin']],
      ['nonadmin', []],
    ] as const) {
      ids[who] = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
      await setRoles(ids[who], [...roles]);
      at[who] = await login(ids[who]);
    }
    const audit = full.conn.model('AuditLog');
    for (const [n, [ip]] of CORPUS.entries()) {
      const eventId = randomUUID();
      eventIds.push(eventId);
      await audit.create({
        eventId,
        timestamp: new Date(),
        actorType: 'user',
        actorId,
        tenantId: DEFAULT_TENANT_ID,
        action: 'AUTH_LOGIN_SUCCESS',
        result: 'success',
        ...(ip !== undefined ? { ip } : {}),
        userAgent: UA(n),
        metadata: { note: 'r71t' },
      });
    }
  };
  let setup: Promise<void> | undefined;
  beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await settled(setup);
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);

  const setRoles = (userId: string, roles: string[]) =>
    full.conn
      .model('UserTenant')
      .updateOne(
        { userId: new Types.ObjectId(userId), tenantId: DEFAULT_TENANT_ID },
        { $set: { roles } },
      );

  async function login(userId: string): Promise<string> {
    await seedConsent(full.conn, {
      userId,
      clientId: bff.clientId,
      resource: FLOW_ADMIN_AUD,
      scopes: ADMIN_SCOPE.split(' '),
    });
    const verifier = randomBytes(32).toString('base64url');
    const sessionId = (await full.app.get(SessionService).create(userId, DEFAULT_TENANT_ID)).id;
    const code = await authorizeCode(full, {
      ...bff,
      sessionId,
      resource: FLOW_ADMIN_AUD,
      scope: ADMIN_SCOPE,
      verifier,
    });
    const res = await formPost(full, '/token', bff, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: FLOW_REDIRECT,
      code_verifier: verifier,
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ access_token: string }>().access_token;
  }

  const get = (token?: string) =>
    full.app.inject({
      method: 'GET',
      url: `/admin/audit?actorId=${actorId}&limit=50`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }) as Promise<InjectResponse>;

  async function list(token: string) {
    const res = await get(token);
    expect(res.statusCode).toBe(200);
    const items = res.json<{ items: Record<string, unknown>[] }>().items;
    expect(items).toHaveLength(CORPUS.length);
    return { body: res.body, byId: new Map(items.map((i) => [i.eventId as string, i])) };
  }

  function expectMasked({ body, byId }: Awaited<ReturnType<typeof list>>): void {
    CORPUS.forEach(([, masked, secrets], n) => {
      const item = byId.get(eventIds[n])!;
      if (masked === undefined) expect('ip' in item).toBe(false);
      else expect(item.ip).toBe(masked);
      expect('userAgent' in item).toBe(false);
      for (const s of secrets) expect(body).not.toContain(s);
    });
    expect(body).not.toContain('R71T-UA');
    expect(body).not.toContain('Mozilla');
    expect(body).not.toContain('userAgent');
  }

  function expectFull({ byId }: Awaited<ReturnType<typeof list>>): void {
    CORPUS.forEach(([ip], n) => {
      const item = byId.get(eventIds[n])!;
      expect(item.ip).toBe(ip);
      expect(item.userAgent).toBe(UA(n));
    });
  }

  it('default env (unset) ⇒ timestamp_1 TTL 180 days (15552000 s) after boot + sync', async () => {
    const idx = (await full.conn.db!.collection('auditlogs').indexes()).find(
      (i) => i.name === 'timestamp_1',
    );
    expect(idx?.expireAfterSeconds).toBe(15552000);
  });

  it('tenant_admin: every corpus entry masked/absent, no full value nor UA anywhere in the raw body', async () => {
    expectMasked(await list(at.tenant));
  });

  it('super_admin: full stored ip + userAgent, verbatim (incl. junk, zone, empty)', async () => {
    expectFull(await list(at.super));
  });

  it('negative actors: anonymous 401, member without admin role 403, neither body leaks', async () => {
    for (const [token, status] of [
      [undefined, 401],
      [at.nonadmin, 403],
    ] as const) {
      const res = await get(token);
      expect(res.statusCode).toBe(status);
      expect(res.body).not.toContain('R71T-UA');
      expect(res.body).not.toContain('203.0.113');
    }
  });

  it('demotion: the same token is masked on the very next request', async () => {
    expectFull(await list(at.demoted));
    await setRoles(ids.demoted, ['tenant_admin']);
    expectMasked(await list(at.demoted));
  });

  it('promotion: a tenant_admin token sees full values right after super_admin is granted', async () => {
    expectMasked(await list(at.promoted));
    await setRoles(ids.promoted, ['tenant_admin', 'super_admin']);
    expectFull(await list(at.promoted));
  });

  it('suspended super_admin membership ⇒ 403, no data', async () => {
    await full.conn
      .model('UserTenant')
      .updateOne(
        { userId: new Types.ObjectId(ids.super), tenantId: DEFAULT_TENANT_ID },
        { $set: { status: 'suspended' } },
      );
    const res = await get(at.super);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('R71T-UA');
  });
});

describe('run 71 tester: AUDIT_RETENTION_DAYS on boot', () => {
  it(
    '30 ⇒ timestamp_1 TTL 2592000 s',
    async () => {
      const full = await bootFullApp({ name: 'r71t-ttl30', env: { AUDIT_RETENTION_DAYS: '30' } });
      try {
        const idx = (await full.conn.db!.collection('auditlogs').indexes()).find(
          (i) => i.name === 'timestamp_1',
        );
        expect(idx?.expireAfterSeconds).toBe(2592000);
      } finally {
        await full.close();
      }
    },
    INT_SETUP_TIMEOUT_MS,
  );

  it.each(['29', '3651', '1e2'])(
    '%j ⇒ boot fails naming the variable',
    async (v) => {
      await expect(
        bootFullApp({ name: 'r71t-bad', env: { AUDIT_RETENTION_DAYS: v } }),
      ).rejects.toThrow(/AUDIT_RETENTION_DAYS/);
    },
    INT_SETUP_TIMEOUT_MS,
  );
});

/**
 * The repo's own CLI (`be/dist/database/mongo/sync-indexes.js`, built from this diff) against a
 * legacy DB of OURS (`vg-int-r71t-cli-*` on vg-test-mongo@27117): plain `timestamp_1` + docs.
 */
describe('run 71 tester: db:sync-indexes CLI on a legacy audit collection', () => {
  const base =
    process.env.TEST_MONGO_URI ?? 'mongodb://localhost:27117/vg-int?directConnection=true';
  const uri = withDbSuffix(base, `r71t-cli-${Date.now()}`);
  let conn: Connection;
  const cli = join(process.cwd(), 'dist', 'database', 'mongo', 'sync-indexes.js');
  const env = (days?: string) => ({
    PATH: process.env.PATH ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
    NODE_ENV: 'test',
    ISSUER: 'http://localhost:4000',
    MONGO_URI: uri,
    REDIS_URL: 'redis://localhost:6479',
    ACCESS_TOKEN_TTL: '900',
    REFRESH_TOKEN_TTL: '2592000',
    SESSION_IDLE_TTL: '3600',
    SESSION_ABSOLUTE_TTL: '86400',
    SESSION_COOKIE_SECURE: 'false',
    KEY_PROVIDER: 'local',
    KEY_LOCAL_DIR: join(process.cwd(), 'test'),
    SMTP_URL: 'smtp://127.0.0.1:9',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
    ADMIN_SEED_EMAIL: 'admin@fixture.test',
    CSRF_SECRET: 'r71t-cli-csrf-not-a-real-secret',
    RATE_LIMIT_WINDOW: '60',
    RATE_LIMIT_MAX: '100000',
    CLIENT_AUTH_FAIL_IP_MAX: '100000',
    CLIENT_AUTH_FAIL_CLIENT_MAX: '100000',
    ...(days !== undefined ? { AUDIT_RETENTION_DAYS: days } : {}),
  });
  const run = (days?: string) =>
    spawnSync(process.execPath, [cli], { env: env(days), encoding: 'utf8', timeout: 60_000 });
  const ttl = async () =>
    (await conn.db!.collection('auditlogs').indexes()).find((i) => i.name === 'timestamp_1')
      ?.expireAfterSeconds;

  beforeAll(async () => {
    // Hard guard: only ever our own vg-int-* DB on the int Mongo (27117).
    expect(uri).toMatch(/^mongodb:\/\/localhost:27117\/vg-int-r71t-cli-\d+\?/);
    conn = await mongoose.createConnection(uri, { autoIndex: false }).asPromise();
    const raw = conn.db!.collection('auditlogs');
    await raw.createIndex({ timestamp: 1 });
    await raw.createIndex({ tenantId: 1, timestamp: -1, _id: -1 });
    const now = Date.now();
    await raw.insertMany(
      [0, 1, 5, 20].map((d) => ({
        eventId: `r71t-${d}`,
        timestamp: new Date(now - d * 86400_000),
        actorType: 'user',
        action: 'AUTH_LOGIN_SUCCESS',
        result: 'success',
      })),
    );
  }, INT_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    if (conn) {
      expect(conn.db!.databaseName).toMatch(/^vg-int-r71t-cli-\d+$/);
      await conn.dropDatabase();
      await conn.close();
    }
  });

  it('unset ⇒ collMod to 180 days in place: exit 0, nothing dropped on AuditLog, 4 docs kept', async () => {
    expect(await ttl()).toBeUndefined();
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/target: localhost:27117\/vg-int-r71t-cli-/);
    expect(r.stdout).toMatch(/^AuditLog: synced$/m);
    expect(await ttl()).toBe(15552000);
    expect(await conn.db!.collection('auditlogs').countDocuments()).toBe(4);
  }, 90_000);

  it('30 ⇒ 2592000 in place, still nothing dropped, docs (< 30 days old) kept, cursor index intact', async () => {
    const r = run('30');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^AuditLog: synced$/m);
    expect(await ttl()).toBe(2592000);
    expect(await conn.db!.collection('auditlogs').countDocuments()).toBe(4);
    const keys = (await conn.db!.collection('auditlogs').indexes()).map((i) => i.key);
    expect(keys).toContainEqual({ tenantId: 1, timestamp: -1, _id: -1 });
  }, 90_000);

  it.each(['29', '3651', '1e2'])(
    '%j ⇒ CLI exits != 0, index untouched',
    async (v) => {
      const r = run(v);
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toMatch(/AUDIT_RETENTION_DAYS/);
      expect(`${r.stdout}${r.stderr}`).not.toContain('r71t-cli-csrf');
      expect(await ttl()).toBe(2592000);
    },
    90_000,
  );
});
