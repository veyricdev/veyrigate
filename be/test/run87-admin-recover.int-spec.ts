import { jest } from '@jest/globals';
import mongoose, { Types, type Connection, type Model } from 'mongoose';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { hashPassword } from '../src/common/crypto/crypto.util';
import {
  recoverSuperAdmin,
  type RecoverArgs,
  type RecoverIo,
  type RecoverResult,
} from '../src/database/admin-recover';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { ADMIN_LOCKED_UNTIL } from '../src/modules/identity/user.service';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';

/**
 * Run 87 T2 (DEBT-252, D87.12–D87.15): `admin-recover` restores a super_admin in production without
 * the dev-only seed. Real Mongo replica set (transactions). Every refusal leaves users/memberships
 * untouched and writes a best-effort failure audit; a success writes membership (+ unlock) and its
 * `ADMIN_RECOVERED` audit in ONE transaction; output never carries the email nor a hash.
 */
const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-admin-recover-${Date.now()}?directConnection=true`;
const EMAIL_DOMAIN = '@recover.fixture.test';
const CODE_LINE = /confirmation code: (\d{4}-\d{4})/;

type Answer = 'right' | 'wrong' | 'eof' | 'silent' | { gate: Promise<void> };

describe('run 87 T2: admin-recover (recoverSuperAdmin) on real Mongo', () => {
  let conn: Connection;
  let users: Model<Record<string, unknown>>;
  let members: Model<Record<string, unknown>>;
  let audits: Model<Record<string, unknown>>;
  let hash = '';

  const boot = async (): Promise<void> => {
    conn = await mongoose.createConnection(MONGO_URI, { autoIndex: false }).asPromise();
    for (const { name, schema } of MODELS) conn.model(name, schema);
    await syncAllIndexes(conn);
    users = conn.model<Record<string, unknown>>('User');
    members = conn.model<Record<string, unknown>>('UserTenant');
    audits = conn.model<Record<string, unknown>>('AuditLog');
    hash = await hashPassword('recover-int-password-1'); // test-only value, throwaway DB
  };
  let setup: Promise<void> | undefined;
  beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS);
  beforeEach(async () => {
    for (const c of ['users', 'usertenants', 'auditlogs', 'tenants']) {
      await conn.collection(c).deleteMany({});
    }
    await conn.collection('tenants').insertOne({ id: DEFAULT_TENANT_ID, name: 'Default' });
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await settled(setup);
    if (!conn) return;
    await conn.dropDatabase();
    await conn.close();
  }, INT_SETUP_TIMEOUT_MS);

  const mkUser = async (
    opts: { roles?: string[]; status?: string; adminLocked?: boolean; member?: boolean } = {},
  ) => {
    const _id = new Types.ObjectId();
    const email = `r87-${_id.toHexString()}${EMAIL_DOMAIN}`;
    await conn.collection('users').insertOne({
      _id,
      email,
      passwordHash: hash,
      profile: {},
      emailVerifiedAt: new Date(),
      ...(opts.adminLocked
        ? {
            lockedUntil: ADMIN_LOCKED_UNTIL,
            adminLockLevel: 'super_admin',
            adminLockMarkAt: new Date(Date.now() - 60_000),
          }
        : {}),
    });
    if (opts.member !== false) {
      await members.create({
        userId: _id,
        tenantId: DEFAULT_TENANT_ID,
        status: opts.status ?? 'active',
        roles: opts.roles ?? [],
      });
    }
    return { id: _id.toHexString(), email };
  };

  const args = (email: string, extra: Partial<RecoverArgs> = {}): RecoverArgs => ({
    email,
    requestedBy: 'alice',
    approvedBy: 'bob',
    ticket: 'INC-87',
    unlock: false,
    allowExistingSuperAdmin: false,
    dryRun: false,
    ...extra,
  });

  /** Run the CLI core; answers the printed confirmation code as asked. */
  const run = async (a: RecoverArgs, answer: Answer = 'right', timeoutMs = 5_000) => {
    const input = new PassThrough();
    const lines: string[] = [];
    let codeSeen!: () => void;
    const prompted = new Promise<void>((r) => (codeSeen = r));
    const io: RecoverIo = {
      input,
      timeoutMs,
      write: (line) => {
        lines.push(line);
        const m = CODE_LINE.exec(line);
        if (!m) return;
        codeSeen();
        if (answer === 'right') input.write(`${m[1]}\n`);
        else if (answer === 'wrong') input.write('0000-0000\n');
        else if (answer === 'eof') input.end();
        else if (typeof answer === 'object') void answer.gate.then(() => input.write(`${m[1]}\n`));
      },
    };
    const result = recoverSuperAdmin(conn, a, io);
    return { result, lines, prompted };
  };
  const runDone = async (a: RecoverArgs, answer: Answer = 'right', timeoutMs?: number) => {
    const r = await run(a, answer, timeoutMs);
    const result = await r.result;
    return { result, out: r.lines.join('\n') };
  };

  const snapshot = async () => ({
    users: await conn.collection('users').find({}).sort({ _id: 1 }).toArray(),
    members: await conn
      .collection('usertenants')
      .find({}, { projection: { superAdminGuard: 0 } })
      .sort({ _id: 1 })
      .toArray(),
  });
  const recovered = (reason?: string) =>
    audits
      .find({ action: 'ADMIN_RECOVERED', ...(reason ? { reason } : {}) })
      .lean<Record<string, unknown>[]>();
  const memberOf = (id: string) =>
    members
      .findOne({ userId: new Types.ObjectId(id), tenantId: DEFAULT_TENANT_ID })
      .lean<{ status: string; roles: string[] }>();

  /** AC11: no email, no hash, no URI credential in any output line. */
  const expectClean = (out: string, email: string) => {
    expect(out).not.toContain(email);
    expect(out).not.toContain(EMAIL_DOMAIN);
    expect(out).not.toContain('$argon2');
    expect(out).not.toMatch(/mongodb:\/\//);
  };

  const refusedWith = async (
    p: Promise<{ result: RecoverResult; out: string }>,
    reason: string,
    email: string,
    before: Awaited<ReturnType<typeof snapshot>>,
  ) => {
    const { result, out } = await p;
    expect(result).toEqual({ status: 'refused', reason });
    expect(await snapshot()).toEqual(before);
    const ev = await recovered(reason);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      result: 'failure',
      actorType: 'system',
      actorId: 'alice',
      tenantId: DEFAULT_TENANT_ID,
    });
    expect(JSON.stringify(ev)).not.toContain(email);
    expectClean(out, email);
    return { ev: ev[0], out };
  };

  it('AC1 no usable super_admin, right code => membership active + super_admin, 1 success audit in the same transaction', async () => {
    const t = await mkUser({ status: 'suspended', roles: ['member'] });
    const { result, out } = await runDone(args(t.email));
    expect(result).toMatchObject({ status: 'recovered', userId: t.id });
    expect(await memberOf(t.id)).toMatchObject({
      status: 'active',
      roles: ['member', 'super_admin'],
    });
    const ev = await recovered();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      action: 'ADMIN_RECOVERED',
      result: 'success',
      actorType: 'system',
      actorId: 'alice',
      tenantId: DEFAULT_TENANT_ID,
      targetType: 'user',
      targetId: t.id,
      eventId: (result as { eventId: string }).eventId,
    });
    expect(Object.keys(ev[0].metadata as object).sort()).toEqual(
      [
        'approvedBy',
        'forced',
        'host',
        'requestedBy',
        'ticket',
        'unlocked',
        'usableSuperAdmins',
      ].sort(),
    );
    expect(ev[0].metadata).toMatchObject({
      requestedBy: 'alice',
      approvedBy: 'bob',
      ticket: 'INC-87',
      unlocked: false,
      forced: false,
      usableSuperAdmins: 0,
    });
    expect(ev[0]).not.toHaveProperty('ip');
    const json = JSON.stringify(ev);
    expect(json).not.toContain(t.email);
    expect(json).not.toContain('$argon2');
    // Plan printed BEFORE the code: target, user id, membership, lock, N.
    const codeAt = out.search(CODE_LINE);
    for (const want of [
      /target: [^\n]+\/vg-int-admin-recover-/,
      t.id,
      /locked: no/,
      /usable super_admins: 0/,
    ]) {
      const at = typeof want === 'string' ? out.indexOf(want) : out.search(want);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThan(codeAt);
    }
    expect(out).toContain(`recovered: user ${t.id}, audit event ${ev[0].eventId as string}`);
    expect(out).toContain(
      JSON.stringify({ alert: true, action: 'ADMIN_RECOVERED', eventId: ev[0].eventId }),
    );
    expectClean(out, t.email);
  });

  it('AC1 user without any default-tenant membership => membership created active + super_admin', async () => {
    const t = await mkUser({ member: false });
    const { result } = await runDone(args(t.email));
    expect(result).toMatchObject({ status: 'recovered' });
    expect(await memberOf(t.id)).toMatchObject({ status: 'active', roles: ['super_admin'] });
  });

  it('AC2 a usable super_admin exists => refused super_admin_exists, nothing changed; forced => success forced:true N=1', async () => {
    await mkUser({ roles: ['super_admin'] });
    const t = await mkUser();
    const before = await snapshot();
    const { out } = await refusedWith(
      runDone(args(t.email)),
      'super_admin_exists',
      t.email,
      before,
    );
    expect(out).not.toMatch(CODE_LINE); // refused before asking anyone to confirm
    const { result } = await runDone(args(t.email, { allowExistingSuperAdmin: true }));
    expect(result).toMatchObject({ status: 'recovered' });
    const [ok] = await audits.find({ action: 'ADMIN_RECOVERED', result: 'success' }).lean();
    expect(ok.metadata).toMatchObject({ forced: true, usableSuperAdmins: 1 });
    expect((await memberOf(t.id))?.roles).toEqual(['super_admin']);
  });

  it('AC2 super_admin memberships that are suspended or of another tenant do not count', async () => {
    await mkUser({ roles: ['super_admin'], status: 'suspended' });
    const other = await mkUser({ member: false });
    await members.create({
      userId: new Types.ObjectId(other.id),
      tenantId: 'other-tenant',
      status: 'active',
      roles: ['super_admin'],
    });
    const t = await mkUser();
    expect((await runDone(args(t.email))).result).toMatchObject({ status: 'recovered' });
  });

  it('AC3 the only super_admin is admin-locked => counts as 0 usable => allowed without force', async () => {
    await mkUser({ roles: ['super_admin'], adminLocked: true });
    const t = await mkUser();
    const { result, out } = await runDone(args(t.email));
    expect(result).toMatchObject({ status: 'recovered' });
    expect(out).toMatch(/usable super_admins: 0/);
    const [ok] = await recovered();
    expect(ok.metadata).toMatchObject({ forced: false, usableSuperAdmins: 0 });
  });

  it('AC4 unknown email => refused user_not_found, no user created, failure audit without targetId', async () => {
    await mkUser();
    const before = await snapshot();
    const email = `nobody${EMAIL_DOMAIN}`;
    const { ev } = await refusedWith(runDone(args(email)), 'user_not_found', email, before);
    expect(ev).not.toHaveProperty('targetId');
    expect(await users.countDocuments()).toBe(1);
  });

  it('AC4 email is matched normalized (trim + lower case)', async () => {
    const t = await mkUser();
    const { result } = await runDone(args(`  ${t.email.toUpperCase()} `));
    expect(result).toMatchObject({ status: 'recovered', userId: t.id });
  });

  it.each(['wrong', 'eof', 'silent'] as const)(
    'AC6 confirmation %s => refused not_confirmed, nothing changed',
    async (answer) => {
      const t = await mkUser();
      const before = await snapshot();
      await refusedWith(runDone(args(t.email), answer, 300), 'not_confirmed', t.email, before);
    },
  );

  it('AC7 target admin-locked without --unlock => target_locked, nothing changed; with --unlock => unlocked + mark moved', async () => {
    const t = await mkUser({ adminLocked: true });
    const before = await snapshot();
    const { out } = await refusedWith(runDone(args(t.email)), 'target_locked', t.email, before);
    expect(out).toMatch(/locked: yes/);
    const markBefore = (before.users[0].adminLockMarkAt as Date).getTime();
    const { result } = await runDone(args(t.email, { unlock: true }));
    expect(result).toMatchObject({ status: 'recovered' });
    const u = await conn.collection('users').findOne({ _id: new Types.ObjectId(t.id) });
    expect(u?.lockedUntil).toBeUndefined();
    expect(u?.adminLockLevel).toBeUndefined();
    expect((u?.adminLockMarkAt as Date).getTime()).toBeGreaterThan(markBefore);
    const [ok] = await audits.find({ action: 'ADMIN_RECOVERED', result: 'success' }).lean();
    expect(ok.metadata).toMatchObject({ unlocked: true });
  });

  it('AC7 --unlock on a user that is not locked => success, unlocked:false', async () => {
    const t = await mkUser();
    expect((await runDone(args(t.email, { unlock: true }))).result).toMatchObject({
      status: 'recovered',
    });
    const [ok] = await recovered();
    expect(ok.metadata).toMatchObject({ unlocked: false });
  });

  it('AC8 the success audit insert fails inside the transaction => abort: membership and lock unchanged, throws', async () => {
    const t = await mkUser({ adminLocked: true });
    const before = await snapshot();
    jest.spyOn(audits, 'create').mockRejectedValue(new Error('audit down') as never);
    const r = await run(args(t.email, { unlock: true }));
    await expect(r.result).rejects.toThrow('audit down');
    expect(await snapshot()).toEqual(before);
  });

  it('AC9 two CLIs for DIFFERENT users released together (x20) => exactly 1 success + 1 super_admin_exists', async () => {
    for (let i = 0; i < 20; i++) {
      await conn.collection('usertenants').deleteMany({});
      await conn.collection('users').deleteMany({});
      await conn.collection('auditlogs').deleteMany({});
      const a = await mkUser();
      const b = await mkUser();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const ra = await run(args(a.email), { gate });
      const rb = await run(args(b.email), { gate });
      await Promise.all([ra.prompted, rb.prompted]); // both planned with N = 0
      release();
      const results = await Promise.all([ra.result, rb.result]);
      expect(results.map((x) => x.status).sort()).toEqual(['recovered', 'refused']);
      expect(results.find((x) => x.status === 'refused')).toEqual({
        status: 'refused',
        reason: 'super_admin_exists',
      });
      expect(await members.countDocuments({ roles: 'super_admin' })).toBe(1);
      expect(await audits.countDocuments({ action: 'ADMIN_RECOVERED', result: 'success' })).toBe(1);
      // DEBT-619: the refusal decided inside the transaction records the count seen there (1).
      const [refusal] = await audits
        .find({ action: 'ADMIN_RECOVERED', result: 'failure' })
        .lean<{ metadata: Record<string, unknown> }[]>();
      expect(refusal.metadata).toMatchObject({ usableSuperAdmins: 1 });
    }
  }, 120_000);

  it('AC9 two CLIs for the SAME user released together => both succeed (idempotent), one super_admin membership', async () => {
    const t = await mkUser();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const r1 = await run(args(t.email), { gate });
    const r2 = await run(args(t.email), { gate });
    await Promise.all([r1.prompted, r2.prompted]);
    release();
    const results = await Promise.all([r1.result, r2.result]);
    expect(results.map((x) => x.status)).toEqual(['recovered', 'recovered']);
    expect(await members.countDocuments({ userId: new Types.ObjectId(t.id) })).toBe(1);
    expect((await memberOf(t.id))?.roles).toEqual(['super_admin']);
  });

  it('confused deputy: DB without the default tenant => throws before any write', async () => {
    const t = await mkUser();
    await conn.collection('tenants').deleteMany({});
    const before = await snapshot();
    const r = await run(args(t.email));
    await expect(r.result).rejects.toThrow(/default-tenant/);
    expect(await snapshot()).toEqual(before);
  });
});

// ---------------------------------------------------------------- built CLI (AC5, AC10, AC11)
const CLI = join(process.cwd(), 'dist', 'database', 'admin-recover.js');
const SECRET = 'recover-cli-s3cret';
const EMAIL = 'ops-admin@cli.fixture.test';
const GOOD = [
  '--email',
  EMAIL,
  '--requested-by',
  'alice',
  '--approved-by',
  'bob',
  '--ticket',
  'INC-1',
];

describe('run 87 T2: built admin-recover CLI argument checks (no connection)', () => {
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
    uri = `mongodb://u:${SECRET}@127.0.0.1:${(counter.address() as AddressInfo).port}/vg-x`;
  });
  afterAll(() => new Promise<void>((r) => counter.close(() => r())));
  beforeEach(() => (accepted = 0));

  const env = () => ({
    PATH: process.env.PATH ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
    NODE_ENV: 'production',
    ISSUER: 'https://idp.example.com',
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
    ADMIN_SEED_EMAIL: 'seed-admin@fixture.test',
    CSRF_SECRET: 'cli-recover-csrf-not-a-real-secret',
    RATE_LIMIT_WINDOW: '60',
    RATE_LIMIT_MAX: '100000',
    CLIENT_AUTH_FAIL_IP_MAX: '100000',
    CLIENT_AUTH_FAIL_CLIENT_MAX: '100000',
  });
  const cli = (argv: string[]) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...argv], { env: env() });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
      child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 30_000);
      child.on('error', reject);
      child.on('close', (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
    });

  it('control: valid args WITHOUT --dry-run => connects (>= 1 socket), exit 1, no credential/email echoed', async () => {
    const r = await cli(GOOD);
    expect(r.status).toBe(1);
    expect(accepted).toBeGreaterThan(0);
    expect(r.stdout).toContain(`target: 127.0.0.1:${uri.split(':').pop()}`);
    expect(r.stdout + r.stderr).not.toContain(SECRET);
    expect(r.stdout + r.stderr).not.toContain(EMAIL);
  }, 40_000);

  it('AC10 --dry-run (NODE_ENV=production) => target + "dry-run: no connection made", exit 0, 0 sockets', async () => {
    const r = await cli(['--', ...GOOD, '--dry-run']);
    expect([r.status, r.stderr]).toEqual([0, '']);
    expect(accepted).toBe(0);
    expect(r.stdout).toContain('dry-run: no connection made');
    expect(r.stdout).toMatch(/^target: 127\.0\.0\.1:\d+\/vg-x\n/);
    expect(r.stdout).not.toContain(SECRET);
    expect(r.stdout).not.toContain(EMAIL);
  }, 30_000);

  it.each([
    ['same requester and approver', ['--approved-by', 'alice']],
    ['missing ticket', ['--ticket', null]],
    ['bad ticket', ['--ticket', 'INC 1; rm']],
    ['bad name', ['--requested-by', 'Alice Smith']],
    ['unknown flag', ['--yes', '']],
  ])(
    'AC5 %s => exit 1 before any connection, value not echoed',
    async (_n, [flag, value]) => {
      let argv = [...GOOD];
      const i = argv.indexOf(flag as string);
      if (i < 0) argv = [...argv, flag as string];
      else if (value === null) argv.splice(i, 2);
      else argv[i + 1] = value as string;
      const r = await cli(argv);
      expect(r.status).toBe(1);
      expect(accepted).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/^admin-recover failed: /);
      for (const v of [EMAIL, SECRET, 'INC 1; rm', 'Alice Smith', '--yes']) {
        expect(r.stderr).not.toContain(v);
      }
    },
    30_000,
  );
});
