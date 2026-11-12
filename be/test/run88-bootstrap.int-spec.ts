import { jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import mongoose, { Types, type Connection, type Model } from 'mongoose';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { join } from 'node:path';
import {
  bootstrapAdminPlane,
  type BootstrapArgs,
  type BootstrapIo,
  type BootstrapResult,
} from '../src/database/bootstrap';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import {
  ClientCredentialService,
  type ClientCredential,
} from '../src/modules/clients/client-credential.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { adminResourceIdentifier } from '../src/modules/oauth/token/token.service';
import { INT_SETUP_TIMEOUT_MS, settled, withDbSuffix } from './int-hooks';

/**
 * Run 88 T1 (DEBT-164/165, D88.2–D88.14): `db:bootstrap` ensures the production admin control plane
 * (tenant, resource `admin`, client `fe-admin`, ONE active credential) in one transaction on a real
 * replica set. At most one secret is ever printed (only after commit), every run writes exactly one
 * `ADMIN_BOOTSTRAPPED` audit in the same transaction, refusals write nothing, users are never touched.
 */
const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-run88-bootstrap-${Date.now()}?directConnection=true`;
const ISSUER = 'https://idp.example.com';
const URIS = {
  redirectUris: ['https://admin.example.com/auth/callback'],
  postLogoutRedirectUris: ['https://admin.example.com/'],
};
const SECRET_LINE = /^OIDC_CLIENT_SECRET=([A-Za-z0-9_-]{43})$/;
const EMAIL = 'r88-admin@bootstrap.fixture.test';
const COLLECTIONS = [
  'tenants',
  'resources',
  'clients',
  'clientcredentials',
  'auditlogs',
  'users',
  'usertenants',
  'opslocks',
];

const args = (extra: Partial<BootstrapArgs> = {}): BootstrapArgs => ({
  operator: 'ops.alice',
  updateUris: false,
  rotateSecret: false,
  dryRun: false,
  ...extra,
});

describe('run 88 T1: bootstrapAdminPlane on a real replica set', () => {
  let conn: Connection;
  let creds: ClientCredentialService;
  let setup: Promise<void> | undefined;

  const boot = async (): Promise<void> => {
    conn = await mongoose.createConnection(MONGO_URI, { autoIndex: false }).asPromise();
    for (const { name, schema } of MODELS) conn.model(name, schema);
    await syncAllIndexes(conn);
    creds = new ClientCredentialService(
      conn.model<ClientCredential>('ClientCredential') as Model<ClientCredential>,
      { getOrThrow: () => ({ secretGraceTtl: 0 }) } as unknown as ConfigService,
    );
  };
  beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS);
  beforeEach(async () => {
    for (const c of COLLECTIONS) await conn.collection(c).deleteMany({});
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await settled(setup);
    if (!conn) return;
    await conn.dropDatabase();
    await conn.close();
  }, INT_SETUP_TIMEOUT_MS);

  const run = async (
    a: BootstrapArgs = args(),
    uris = URIS,
    io: Partial<BootstrapIo> = {},
    c: Connection = conn,
  ): Promise<{ result: BootstrapResult; lines: string[]; out: string }> => {
    const lines: string[] = [];
    const result = await bootstrapAdminPlane(
      c,
      { issuer: ISSUER, uris, args: a },
      { write: (l) => void lines.push(l), ...io },
    );
    return { result, lines, out: lines.join('\n') };
  };
  const secretsIn = (lines: string[]) =>
    lines.map((l) => SECRET_LINE.exec(l)?.[1]).filter((s): s is string => !!s);
  const activeCount = () =>
    conn.collection('clientcredentials').countDocuments({ clientId: 'fe-admin', revokedAt: null });
  const bootstrapAudits = () =>
    conn.collection('auditlogs').find({ action: 'ADMIN_BOOTSTRAPPED' }).toArray();
  const snapshot = async () => {
    const all: Record<string, unknown[]> = {};
    for (const c of COLLECTIONS) {
      all[c] = await conn.collection(c).find({}).sort({ _id: 1 }).toArray();
    }
    return all;
  };
  const expectClean = (out: string) => {
    expect(out).not.toContain('$argon2');
    expect(out).not.toContain(EMAIL);
    expect(out).not.toMatch(/mongodb:\/\/[^\s]*@/);
  };
  const insertUser = async (superAdmin: boolean) => {
    const _id = new Types.ObjectId();
    await conn.collection('users').insertOne({ _id, email: EMAIL, profile: {} });
    await conn.collection('usertenants').insertOne({
      userId: _id,
      tenantId: DEFAULT_TENANT_ID,
      status: 'active',
      roles: superAdmin ? ['super_admin'] : [],
    });
  };

  it('AC1 empty synced DB => tenant + resource admin + fe-admin + 1 credential, secret printed once and valid, audit', async () => {
    const { result, lines, out } = await run();
    expect(result).toMatchObject({
      status: 'ok',
      created: { tenant: true, resource: true, client: true },
      secretIssued: true,
      secretRotated: false,
      urisUpdated: false,
    });
    expect(lines[0]).toMatch(/^target: .+\/vg-int-run88-bootstrap-/);
    const secrets = secretsIn(lines);
    expect(secrets).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('OIDC_CLIENT_SECRET='))).toHaveLength(1);
    expect(out).toContain('shown once, store it in the fe-admin secret store now');
    expect(await creds.verifySecret('fe-admin', secrets[0])).toMatchObject({ valid: true });

    expect(await conn.collection('tenants').countDocuments({ id: DEFAULT_TENANT_ID })).toBe(1);
    const resource = await conn.collection('resources').findOne({ resourceId: 'admin' });
    expect(resource).toMatchObject({
      identifier: adminResourceIdentifier(ISSUER),
      scopes: ['admin.read', 'admin.write'],
    });
    const client = await conn.collection('clients').findOne({ clientId: 'fe-admin' });
    expect(client).toMatchObject({
      clientType: 'confidential',
      tokenEndpointAuthMethod: 'client_secret_basic',
      grantTypes: ['authorization_code', 'refresh_token'],
      redirectUris: URIS.redirectUris,
      postLogoutRedirectUris: URIS.postLogoutRedirectUris,
      allowedCorsOrigins: [],
      allowedResources: ['admin'],
      tenantId: DEFAULT_TENANT_ID,
    });
    expect(await activeCount()).toBe(1);

    const audits = await bootstrapAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: 'system',
      actorId: 'ops.alice',
      tenantId: DEFAULT_TENANT_ID,
      targetType: 'client',
      targetId: 'fe-admin',
      result: 'success',
      metadata: {
        createdTenant: true,
        createdResource: true,
        createdClient: true,
        // `secret*` keys are dropped by sanitizeMetadata: credential* carries D88.11's secretIssued/Rotated.
        credentialIssued: true,
        credentialRotated: false,
        urisUpdated: false,
      },
    });
    expect(JSON.stringify(audits[0])).not.toContain(secrets[0]);
    expect(lines).toContain(
      JSON.stringify({ alert: true, action: 'ADMIN_BOOTSTRAPPED', eventId: audits[0].eventId }),
    );
    expectClean(out);
  });

  it('AC2 re-run => no secret line, credentials unchanged, "unchanged", audit secretIssued:false', async () => {
    await run();
    const before = await conn.collection('clientcredentials').find({}).toArray();
    const { result, lines, out } = await run();
    expect(result).toMatchObject({
      status: 'ok',
      created: { tenant: false, resource: false, client: false },
      secretIssued: false,
    });
    expect(lines.some((l) => l.includes('OIDC_CLIENT_SECRET='))).toBe(false);
    expect(out).toContain('fe-admin secret: unchanged (active credential exists)');
    expect(await conn.collection('clientcredentials').find({}).toArray()).toEqual(before);
    const audits = await bootstrapAudits();
    expect(audits.map((a) => a.metadata.credentialIssued)).toEqual([true, false]);
    // D88.6: every committed run went through the serialization document (refusals roll it back, AC6).
    // Behaviourally the unique indexes also force a write conflict between two first runs, so this
    // is the check that pins the touch itself.
    expect(await conn.collection('opslocks').findOne({ _id: 'bootstrap' as never })).toEqual({
      _id: 'bootstrap',
      n: 2,
    });
    expectClean(out);
  });

  it('AC3 two concurrent runs on an empty DB (barrier before the touch) x20 => exactly 1 credential, 1 secret line', async () => {
    for (let i = 0; i < 20; i++) {
      for (const c of COLLECTIONS) await conn.collection(c).deleteMany({});
      let arrived = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const beforeTouch = async () => {
        arrived += 1;
        if (arrived === 2) release();
        await gate;
      };
      const [a, b] = await Promise.all([
        run(args(), URIS, { beforeTouch }),
        run(args(), URIS, { beforeTouch }),
      ]);
      expect(secretsIn([...a.lines, ...b.lines])).toHaveLength(1);
      expect(await activeCount()).toBe(1);
      expect(await conn.collection('clientcredentials').countDocuments({})).toBe(1);
      expect(await conn.collection('clients').countDocuments({ clientId: 'fe-admin' })).toBe(1);
      expect(await conn.collection('resources').countDocuments({ resourceId: 'admin' })).toBe(1);
      expect(await conn.collection('tenants').countDocuments({})).toBe(1);
      expect((await bootstrapAudits()).map((x) => x.metadata.credentialIssued).sort()).toEqual([
        false,
        true,
      ]);
    }
  }, 120_000);

  it('AC4 stored URIs differ => drift (exit 2), DB unchanged; --update-uris --ticket replaces both + REDIRECT_URI_CHANGED', async () => {
    await run();
    const other = {
      redirectUris: ['https://console.example.org/auth/callback'],
      postLogoutRedirectUris: ['https://console.example.org/'],
    };
    const before = await snapshot();
    const drift = await run(args(), other);
    expect(drift.result).toEqual({ status: 'drift' });
    expect(drift.out).toContain('https://admin.example.com/auth/callback');
    expect(drift.out).toContain('https://console.example.org/auth/callback');
    expect(secretsIn(drift.lines)).toHaveLength(0);
    expect(await snapshot()).toEqual(before);

    const upd = await run(args({ updateUris: true, ticket: 'T-1' }), other);
    expect(upd.result).toMatchObject({ status: 'ok', urisUpdated: true, secretIssued: false });
    expect(await conn.collection('clients').findOne({ clientId: 'fe-admin' })).toMatchObject(other);
    const changed = await conn
      .collection('auditlogs')
      .find({ action: 'REDIRECT_URI_CHANGED' })
      .toArray();
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      actorType: 'system',
      actorId: 'ops.alice',
      targetId: 'fe-admin',
    });
    expect(changed[0].metadata).toMatchObject({ ticket: 'T-1' });
    expect((await bootstrapAudits()).at(-1)?.metadata).toMatchObject({
      urisUpdated: true,
      ticket: 'T-1',
    });
  });

  it('AC4 --update-uris with equal URIs => nothing to update (urisUpdated:false, no REDIRECT_URI_CHANGED)', async () => {
    await run();
    const r = await run(args({ updateUris: true, ticket: 'T-1' }));
    expect(r.result).toMatchObject({ status: 'ok', urisUpdated: false });
    expect(
      await conn.collection('auditlogs').countDocuments({ action: 'REDIRECT_URI_CHANGED' }),
    ).toBe(0);
  });

  it('AC5 --rotate-secret --ticket => every old credential revoked now, old secret fails, 1 new active printed once', async () => {
    const first = secretsIn((await run()).lines)[0];
    const r = await run(args({ rotateSecret: true, ticket: 'T-2' }));
    expect(r.result).toMatchObject({ status: 'ok', secretIssued: true, secretRotated: true });
    const next = secretsIn(r.lines);
    expect(next).toHaveLength(1);
    expect(next[0]).not.toBe(first);
    expect((await creds.verifySecret('fe-admin', first)).valid).toBe(false);
    expect(await creds.verifySecret('fe-admin', next[0])).toEqual({ valid: true, version: 2 });
    expect(await activeCount()).toBe(1);
    expect(
      await conn
        .collection('clientcredentials')
        .countDocuments({ version: 1, revokedAt: { $type: 'date' } }),
    ).toBe(1);
    expect((await bootstrapAudits()).at(-1)?.metadata).toMatchObject({
      credentialRotated: true,
      credentialIssued: true,
      ticket: 'T-2',
    });
  });

  describe('AC6 refusals => throw, nothing written (every collection compared)', () => {
    const expectRefused = async (re: RegExp) => {
      const before = await snapshot();
      await expect(run()).rejects.toThrow(re);
      expect(await snapshot()).toEqual(before);
    };

    it('resource admin pointing at another identifier', async () => {
      await conn.collection('resources').insertOne({
        resourceId: 'admin',
        identifier: 'https://legacy.example.com/admin/',
        scopes: [],
      });
      await expectRefused(/refusing to point resource 'admin'.*already exists with identifier/);
    });

    it('another client already references admin (no admin resource yet)', async () => {
      await conn.collection('clients').insertOne({
        clientId: 'x',
        clientType: 'confidential',
        tokenEndpointAuthMethod: 'client_secret_basic',
        allowedResources: ['admin'],
        tenantId: DEFAULT_TENANT_ID,
      });
      await expectRefused(/client x already references it/);
    });

    it('fe-admin exists as a public client (token auth none)', async () => {
      await conn.collection('clients').insertOne({
        clientId: 'fe-admin',
        clientType: 'public',
        tokenEndpointAuthMethod: 'none',
        allowedResources: [],
        redirectUris: URIS.redirectUris,
        postLogoutRedirectUris: URIS.postLogoutRedirectUris,
        tenantId: DEFAULT_TENANT_ID,
      });
      await expectRefused(/not admin-capable/);
    });

    it('a required unique index is missing => "run db:sync-indexes first"', async () => {
      const other = await mongoose
        .createConnection(withDbSuffix(MONGO_URI, 'noidx'), { autoIndex: false })
        .asPromise();
      try {
        for (const { name, schema } of MODELS) other.model(name, schema);
        await syncAllIndexes(other);
        await other.collection('clientcredentials').dropIndex('clientId_1_version_1');
        const collections = async () =>
          Promise.all(COLLECTIONS.map((c) => other.collection(c).countDocuments({})));
        const before = await collections();
        await expect(run(args(), URIS, {}, other)).rejects.toThrow(/run db:sync-indexes first/);
        expect(await collections()).toEqual(before);
      } finally {
        await other.dropDatabase();
        await other.close();
      }
    });
  });

  it('AC8 startSession / withTransaction throws => "replica set", nothing written, no secret', async () => {
    jest
      .spyOn(conn, 'startSession')
      .mockRejectedValueOnce(
        new Error('Transaction numbers are only allowed on a replica set member or mongos'),
      );
    const before = await snapshot();
    const lines: string[] = [];
    await expect(
      bootstrapAdminPlane(
        conn,
        { issuer: ISSUER, uris: URIS, args: args() },
        { write: (l) => void lines.push(l) },
      ),
    ).rejects.toThrow(/replica set/);
    expect(await snapshot()).toEqual(before);
    expect(secretsIn(lines)).toHaveLength(0);
  });

  it('AC8 audit insert throws inside the transaction => no tenant/client/credential, no secret printed', async () => {
    jest
      .spyOn(conn.model('AuditLog'), 'create')
      .mockRejectedValue(Object.assign(new Error('audit down'), { code: 2 }) as never);
    const before = await snapshot();
    const lines: string[] = [];
    await expect(
      bootstrapAdminPlane(
        conn,
        { issuer: ISSUER, uris: URIS, args: args() },
        { write: (l) => void lines.push(l) },
      ),
    ).rejects.toThrow(/nothing was written/);
    expect(await snapshot()).toEqual(before);
    expect(lines.some((l) => l.includes('OIDC_CLIENT_SECRET'))).toBe(false);
  });

  it('AC8 commit fails after every write => no audit, no client, no credential, no secret (audit is in the transaction)', async () => {
    const real = conn.startSession.bind(conn);
    jest.spyOn(conn, 'startSession').mockImplementationOnce(async (...a: unknown[]) => {
      const s = await real(...(a as []));
      jest.spyOn(s, 'commitTransaction').mockRejectedValue(new Error('commit refused') as never);
      return s;
    });
    const before = await snapshot();
    const lines: string[] = [];
    await expect(
      bootstrapAdminPlane(
        conn,
        { issuer: ISSUER, uris: URIS, args: args() },
        { write: (l) => void lines.push(l) },
      ),
    ).rejects.toThrow(/nothing was written/);
    expect(await snapshot()).toEqual(before);
    expect(lines.some((l) => l.includes('OIDC_CLIENT_SECRET'))).toBe(false);
  });

  it('D88.7 stdout fails on the secret line after commit => error naming --rotate-secret; the credential exists', async () => {
    const lines: string[] = [];
    await expect(
      bootstrapAdminPlane(
        conn,
        { issuer: ISSUER, uris: URIS, args: args() },
        {
          write: (l) => {
            if (l.startsWith('OIDC_CLIENT_SECRET=')) return Promise.reject(new Error('EPIPE'));
            lines.push(l);
            return Promise.resolve();
          },
        },
      ),
    ).rejects.toThrow(/--rotate-secret/);
    expect(await activeCount()).toBe(1);
    expect(lines.join('\n')).not.toMatch(/OIDC_CLIENT_SECRET/);
  });

  it('AC9 users/usertenants untouched; 0 usable super_admins => hint to db:admin-recover', async () => {
    await insertUser(false);
    const users = await conn.collection('users').find({}).toArray();
    const members = await conn.collection('usertenants').find({}).toArray();
    const { out } = await run();
    expect(out).toContain('usable super_admins: 0');
    expect(out).toMatch(/\/register.*db:admin-recover/);
    expect(await conn.collection('users').find({}).toArray()).toEqual(users);
    expect(await conn.collection('usertenants').find({}).toArray()).toEqual(members);
    expectClean(out);
  });

  it('AC9 one usable super_admin => "usable super_admins: 1", no hint', async () => {
    await insertUser(true);
    const { out } = await run();
    expect(out).toContain('usable super_admins: 1');
    expect(out).not.toContain('db:admin-recover');
    expectClean(out);
  });
});

const CLI = join(process.cwd(), 'dist', 'database', 'bootstrap.js');
const PASSWORD = 'r88-mongo-password-not-real';

describe('run 88 T1: built bootstrap CLI (no connection paths, AC7/AC10)', () => {
  let counter: Server;
  let accepted = 0;
  let uri = '';

  beforeAll(async () => {
    if (!existsSync(CLI)) throw new Error(`${CLI} missing: run pnpm -C be build`);
    counter = createServer((s) => {
      accepted += 1;
      s.destroy();
    });
    await new Promise<void>((r) => counter.listen(0, '127.0.0.1', r));
    uri = `mongodb://u:${PASSWORD}@127.0.0.1:${(counter.address() as AddressInfo).port}/vg-x`;
  });
  afterAll(() => new Promise<void>((r) => counter.close(() => r())));
  beforeEach(() => (accepted = 0));

  const env = (extra: Record<string, string> = {}) => ({
    PATH: process.env.PATH ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
    NODE_ENV: 'production',
    ISSUER,
    MONGO_URI: uri,
    REDIS_URL: 'redis://127.0.0.1:1',
    ACCESS_TOKEN_TTL: '900',
    REFRESH_TOKEN_TTL: '2592000',
    SESSION_IDLE_TTL: '3600',
    SESSION_ABSOLUTE_TTL: '86400',
    SESSION_COOKIE_SECURE: 'true',
    KEY_PROVIDER: 'vault',
    VAULT_ADDR: 'https://127.0.0.1:1',
    VAULT_TOKEN_FILE: join(process.cwd(), 'test', 'no-such-token-file'),
    VAULT_TRANSIT_KEY: 'idp-signer',
    SMTP_URL: 'smtp://127.0.0.1:9',
    // DEBT-165: no ADMIN_SEED_EMAIL in a production env.
    CSRF_SECRET: 'cli-bootstrap-csrf-not-a-real-secret',
    RATE_LIMIT_WINDOW: '60',
    RATE_LIMIT_MAX: '100000',
    CLIENT_AUTH_FAIL_IP_MAX: '100000',
    CLIENT_AUTH_FAIL_CLIENT_MAX: '100000',
    BOOTSTRAP_FE_ADMIN_REDIRECT_URIS: 'https://admin.example.com/auth/callback',
    BOOTSTRAP_FE_ADMIN_POST_LOGOUT_REDIRECT_URIS: 'https://admin.example.com/',
    ...extra,
  });
  const cli = (argv: string[], extra?: Record<string, string>) =>
    new Promise<{ status: number | null; stdout: string; stderr: string; ms: number }>(
      (resolve, reject) => {
        const t0 = Date.now();
        const child = spawn(process.execPath, [CLI, ...argv], { env: env(extra) });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
        child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
        child.stdin.end();
        const timer = setTimeout(() => child.kill(), 30_000);
        child.on('error', reject);
        child.on('close', (status) => {
          clearTimeout(timer);
          resolve({ status, stdout, stderr, ms: Date.now() - t0 });
        });
      },
    );

  it('control: valid args without --dry-run => connects (>= 1 socket), exit 1, nothing echoed', async () => {
    const r = await cli(['--operator', 'ops']);
    expect(r.status).toBe(1);
    expect(accepted).toBeGreaterThan(0);
    expect(r.stdout + r.stderr).not.toContain(PASSWORD);
  }, 40_000);

  it('AC10 --dry-run (production, no ADMIN_SEED_EMAIL) => target + URIs + "dry-run: no connection made", exit 0, 0 sockets', async () => {
    const r = await cli(['--', '--operator', 'ops', '--dry-run']);
    expect([r.status, r.stderr]).toEqual([0, '']);
    expect(accepted).toBe(0);
    expect(r.stdout).toMatch(/^target: 127\.0\.0\.1:\d+\/vg-x\n/);
    expect(r.stdout).toContain('fe-admin redirectUris: https://admin.example.com/auth/callback');
    expect(r.stdout).toContain('dry-run: no connection made');
    expect(r.stdout).not.toContain(PASSWORD);
  }, 30_000);

  it.each([
    ['unknown flag', ['--operator', 'ops', '--yes'], {}],
    ['bad operator', ['--operator', 'Ops Alice'], {}],
    ['--update-uris without ticket', ['--operator', 'ops', '--update-uris'], {}],
    [
      'http://localhost redirect URI in production',
      ['--operator', 'ops'],
      { BOOTSTRAP_FE_ADMIN_REDIRECT_URIS: 'http://localhost:3000/auth/callback' },
    ],
    [
      'wildcard redirect URI',
      ['--operator', 'ops'],
      { BOOTSTRAP_FE_ADMIN_REDIRECT_URIS: 'https://*.example.com/cb' },
    ],
    [
      'fragment in the post-logout URI',
      ['--operator', 'ops'],
      { BOOTSTRAP_FE_ADMIN_POST_LOGOUT_REDIRECT_URIS: 'https://admin.example.com/#x' },
    ],
  ])(
    'AC7/AC10 %s => exit 1 before any connection (< 5 s), nothing echoed',
    async (_n, argv, extra) => {
      const r = await cli(argv as string[], extra as Record<string, string>);
      expect(r.status).toBe(1);
      expect(accepted).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/^bootstrap failed: /);
      for (const v of [
        PASSWORD,
        '--yes',
        'Ops Alice',
        'localhost:3000',
        '*.example.com',
        'admin.example.com/#x',
      ]) {
        expect(r.stderr).not.toContain(v);
      }
      expect(r.ms).toBeLessThan(5_000);
    },
    30_000,
  );
});
