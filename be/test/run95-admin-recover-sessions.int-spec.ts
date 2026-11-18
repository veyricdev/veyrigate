import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import mongoose, { Types, type Connection, type Model } from 'mongoose';
import { PassThrough } from 'node:stream';
import { sha256 } from '../src/common/crypto/crypto.util';
import {
  exitCodeOf,
  recoverSuperAdmin,
  sessionRevoker,
  type RecoverArgs,
  type RecoverIo,
} from '../src/database/admin-recover';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { RedisService } from '../src/database/redis/redis.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { trustKey } from '../src/modules/authentication/login-throttle.service';
import { SessionService } from '../src/modules/sessions/session.service';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';

/**
 * Run 95 T1 (DEBT-634, D95.1–D95.7): `admin-recover --reset-mfa` ends every Redis session of the
 * user AFTER the Mongo commit (same `SessionService.revokeAllForUser` as the admin API), forgets the
 * trusted devices, sweeps refresh families again, and audits `SESSION_REVOKED {via:'admin_recover'}`.
 * Redis down => Mongo stays committed, fixed warning, exit code 3. `/authorize` reads the session
 * through `sessions.get`, so `get === null` is "must sign in again" at every RP (D95.7).
 */
const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-admin-recover-sessions-${Date.now()}?directConnection=true`;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';
const EMAIL_DOMAIN = '@recover95.fixture.test';
const CODE_LINE = /confirmation code: (\d{4}-\d{4})/;
const WARNING_REDIS =
  'warning: recovered, but sessions were NOT revoked (redis): see runbook-ops section 11';

/** The CLI's ConfigService shape (`buildConfig`), only the groups the revoker reads. */
const cliConfig = (redisUrl: string) =>
  new ConfigService({
    app: { nodeEnv: 'test', port: 0, issuer: 'https://idp.example.com', trustProxy: false },
    database: { mongoUri: MONGO_URI, redisUrl, redisCommandTimeoutMs: 1000 },
    token: {
      accessTokenTtl: 900,
      refreshTokenTtl: 2_592_000,
      sessionIdleTtl: 3600,
      sessionAbsoluteTtl: 86_400,
    },
  });

describe('run 95 T1: admin-recover --reset-mfa revokes Redis sessions after the commit', () => {
  let conn: Connection;
  let audits: Model<Record<string, unknown>>;
  let redis: IORedis;
  let sessions: SessionService;
  const touchedUsers: string[] = [];

  const boot = async (): Promise<void> => {
    conn = await mongoose.createConnection(MONGO_URI, { autoIndex: false }).asPromise();
    for (const { name, schema } of MODELS) conn.model(name, schema);
    await syncAllIndexes(conn);
    audits = conn.model<Record<string, unknown>>('AuditLog');
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    sessions = new SessionService(new RedisService(redis), cliConfig(REDIS_URL));
  };
  let setup: Promise<void> | undefined;
  beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS);
  beforeEach(async () => {
    for (const c of ['users', 'usertenants', 'auditlogs', 'tenants', 'refreshtokens']) {
      await conn.collection(c).deleteMany({});
    }
    await conn.collection('tenants').insertOne({ id: DEFAULT_TENANT_ID, name: 'Default' });
  });
  afterAll(async () => {
    await settled(setup);
    if (redis) {
      // Only the keys this spec created: sessions (revoke = delete + short-lived tombstone) and
      // the trusted-device ZSETs.
      for (const id of touchedUsers) {
        await sessions.revokeAllForUser(id);
        await redis.del(trustKey(id));
      }
      await redis.quit();
    }
    if (!conn) return;
    await conn.dropDatabase();
    await conn.close();
  }, INT_SETUP_TIMEOUT_MS);

  const mkUser = async (opts: { mfa?: boolean } = {}) => {
    const _id = new Types.ObjectId();
    const id = _id.toHexString();
    const email = `r95-${id}${EMAIL_DOMAIN}`;
    await conn.collection('users').insertOne({
      _id,
      email,
      passwordHash: 'not-a-hash',
      profile: {},
      emailVerifiedAt: new Date(),
      ...(opts.mfa === false
        ? {}
        : {
            mfa: {
              secret: { kid: 'k1', iv: 'aXY=', ct: 'Y3Q=', tag: 'dGFn' },
              enrolledAt: new Date(Date.now() - 86_400_000),
              recoverySalt: 'ab'.repeat(16),
              recovery: [],
              failures: 0,
            },
          }),
    });
    await conn.collection('refreshtokens').insertOne({
      tokenHash: `${id}-fam`,
      familyId: `${id}-fam`,
      userId: _id,
      clientId: 'fe-admin',
      scope: ['admin.read'],
      resource: 'https://idp.example.com/admin/',
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
      revokedAt: null,
    });
    touchedUsers.push(id);
    return { id, email };
  };

  /** Two live sessions (with `mfaAt`) + one trusted device, as a signed-in browser leaves them. */
  const signIn = async (userId: string) => {
    const a = await sessions.create(userId, DEFAULT_TENANT_ID, { amr: ['pwd', 'otp'], mfaAt: 1 });
    const b = await sessions.create(userId, DEFAULT_TENANT_ID, { amr: ['pwd', 'otp'], mfaAt: 1 });
    await redis.zadd(trustKey(userId), Date.now(), sha256(`device-${userId}`));
    return [a, b];
  };

  const args = (email: string, extra: Partial<RecoverArgs> = {}): RecoverArgs => ({
    email,
    requestedBy: 'alice',
    approvedBy: 'bob',
    ticket: 'INC-95',
    unlock: false,
    allowExistingSuperAdmin: false,
    dryRun: false,
    resetMfa: true,
    ...extra,
  });

  const run = async (a: RecoverArgs, revokeSessions?: RecoverIo['revokeSessions']) => {
    const input = new PassThrough();
    const lines: string[] = [];
    const io: RecoverIo = {
      input,
      timeoutMs: 5_000,
      write: (line) => {
        lines.push(line);
        const m = CODE_LINE.exec(line);
        if (m) input.write(`${m[1]}\n`);
      },
      ...(revokeSessions ? { revokeSessions } : {}),
    };
    const result = await recoverSuperAdmin(conn, a, io);
    return { result, lines, out: lines.join('\n') };
  };

  const revokedAudits = () =>
    audits.find({ action: 'SESSION_REVOKED' }).lean<Record<string, unknown>[]>();
  const recoveredId = async () =>
    (await audits.findOne({ action: 'ADMIN_RECOVERED' }).lean<{ eventId: string }>())!.eventId;
  const liveFamilies = (id: string) =>
    conn
      .collection('refreshtokens')
      .countDocuments({ userId: new Types.ObjectId(id), revokedAt: null });
  const expectClean = (out: string, email: string) => {
    expect(out).not.toContain(email);
    expect(out).not.toContain(EMAIL_DOMAIN);
    expect(out).not.toMatch(/redis:\/\/|mongodb:\/\//);
  };

  it('D95.7 (1)(2) --reset-mfa with the real revoker => both sessions dead + tombstoned, index and trusted devices gone, other user untouched, audit count 2', async () => {
    const t = await mkUser();
    const other = await mkUser();
    const [a, b] = await signIn(t.id);
    const [o] = await signIn(other.id);
    const revoker = sessionRevoker(cliConfig(REDIS_URL), () => undefined);
    let r: Awaited<ReturnType<typeof run>>;
    try {
      r = await run(args(t.email), revoker.revokeSessions);
    } finally {
      revoker.close();
    }
    expect(r.result).toMatchObject({
      status: 'recovered',
      userId: t.id,
      sessions: { revoked: 2 },
    });
    expect(exitCodeOf(r.result)).toBe(0);
    expect(r.lines).toContain('sessions revoked: 2');
    for (const s of [a, b]) {
      expect(await sessions.get(s.id)).toBeNull();
      expect(await sessions.isEnded(s.session.ref)).toBe(true);
    }
    expect(await redis.smembers(`user_sess:${t.id}`)).toEqual([]);
    expect(await redis.exists(trustKey(t.id))).toBe(0);
    expect(await liveFamilies(t.id)).toBe(0);
    // (2) no spill-over: the other user's session, device and family stay.
    expect(await sessions.get(o.id)).not.toBeNull();
    expect(await sessions.isEnded(o.session.ref)).toBe(false);
    expect(await redis.exists(trustKey(other.id))).toBe(1);
    expect(await liveFamilies(other.id)).toBe(1);

    const evs = await revokedAudits();
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      action: 'SESSION_REVOKED',
      result: 'success',
      actorType: 'system',
      actorId: 'alice',
      tenantId: DEFAULT_TENANT_ID,
      targetType: 'user',
      targetId: t.id,
      metadata: {
        scope: 'all',
        via: 'admin_recover',
        recoveredEventId: await recoveredId(),
        count: 2,
      },
    });
    expectClean(r.out, t.email);
  });

  it('D95.3 a refresh family minted between the commit and the revoke is swept after Redis', async () => {
    const t = await mkUser();
    await signIn(t.id);
    const revoker = sessionRevoker(cliConfig(REDIS_URL), () => undefined);
    const lateFamily = async (userId: string) => {
      // `/token` raced the commit: a live family appears before the Redis step runs.
      await conn.collection('refreshtokens').insertOne({
        tokenHash: `${userId}-late`,
        familyId: `${userId}-late`,
        userId: new Types.ObjectId(userId),
        clientId: 'fe-admin',
        scope: ['admin.read'],
        resource: 'https://idp.example.com/admin/',
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000),
        revokedAt: null,
      });
      return revoker.revokeSessions(userId);
    };
    try {
      const r = await run(args(t.email), lateFamily);
      expect(r.result).toMatchObject({ sessions: { revoked: 2 } });
    } finally {
      revoker.close();
    }
    expect(await liveFamilies(t.id)).toBe(0);
  });

  it('D95.7 (3) Redis unreachable (main builder on redis://127.0.0.1:1) => Mongo committed, sessions failed, failure audit, fixed warning, exit 3, < 12 s', async () => {
    const t = await mkUser();
    const [a] = await signIn(t.id);
    const started = Date.now();
    const warnings: string[] = [];
    const revoker = sessionRevoker(cliConfig('redis://127.0.0.1:1'), (l) => warnings.push(l));
    let r: Awaited<ReturnType<typeof run>>;
    try {
      r = await run(args(t.email), revoker.revokeSessions);
    } finally {
      revoker.close();
    }
    expect(Date.now() - started).toBeLessThan(12_000);
    expect(r.result).toMatchObject({ status: 'recovered', userId: t.id, sessions: 'failed' });
    expect(exitCodeOf(r.result)).toBe(3);
    expect(r.lines).toContain(WARNING_REDIS);
    // Mongo committed: membership + factor removed + families revoked.
    const m = await conn
      .collection('usertenants')
      .findOne({ userId: new Types.ObjectId(t.id), tenantId: DEFAULT_TENANT_ID });
    expect(m).toMatchObject({ status: 'active', roles: ['super_admin'] });
    const u = await conn.collection('users').findOne({ _id: new Types.ObjectId(t.id) });
    expect(u?.mfa).toBeUndefined();
    expect(await liveFamilies(t.id)).toBe(0);
    // The real Redis was not touched by the failed revoker.
    expect(await sessions.get(a.id)).not.toBeNull();

    const evs = await revokedAudits();
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      result: 'failure',
      reason: 'revoke_failed',
      actorType: 'system',
      actorId: 'alice',
      targetId: t.id,
      metadata: {
        scope: 'all',
        via: 'admin_recover',
        recoveredEventId: await recoveredId(),
        failedStep: 'sessions',
      },
    });
    expect((evs[0].metadata as Record<string, unknown>).count).toBeUndefined();
    expectClean(r.out + warnings.join('\n'), t.email);
  }, 20_000);

  it('D95.4 a revoker that never answers is cut at the bound => sessions failed, exit 3', async () => {
    const t = await mkUser();
    const io = { revokeTimeoutMs: 200 };
    const input = new PassThrough();
    const lines: string[] = [];
    const result = await recoverSuperAdmin(conn, args(t.email), {
      input,
      timeoutMs: 5_000,
      ...io,
      revokeSessions: () => new Promise<number>(() => undefined),
      write: (line) => {
        lines.push(line);
        const m = CODE_LINE.exec(line);
        if (m) input.write(`${m[1]}\n`);
      },
    });
    expect(result).toMatchObject({ status: 'recovered', sessions: 'failed' });
    expect(exitCodeOf(result)).toBe(3);
    expect(lines).toContain(WARNING_REDIS);
  });

  it('D95.6 the sweep fails after a good Redis revoke => sessions failed (sweep), failedStep sweep, exit 3', async () => {
    const t = await mkUser();
    const refresh = conn.collection('refreshtokens');
    const original = refresh.updateMany.bind(refresh);
    let calls = 0;
    const spy = jest.spyOn(refresh, 'updateMany').mockImplementation(((...a: unknown[]) => {
      calls += 1;
      // The two in-transaction updates pass; the post-Redis sweep fails.
      if (calls > 2) return Promise.reject(new Error('sweep down'));
      return (original as (...x: unknown[]) => unknown)(...a);
    }) as never);
    try {
      const r = await run(args(t.email), () => Promise.resolve(2));
      expect(r.result).toMatchObject({ status: 'recovered', sessions: 'failed' });
      expect(exitCodeOf(r.result)).toBe(3);
      // DEBT-692: the Redis step succeeded, only the family sweep did not.
      expect(r.lines).toContain(
        'warning: recovered, sessions revoked: 2, but refresh families were NOT swept (sweep): see runbook-ops section 11',
      );
      expect(r.out).not.toContain('sessions were NOT revoked');
      const [ev] = await revokedAudits();
      expect(ev).toMatchObject({ result: 'failure', metadata: { failedStep: 'sweep' } });
    } finally {
      spy.mockRestore();
    }
  });

  it('D95.6 the SESSION_REVOKED audit insert fails => fixed warning, exit code unchanged', async () => {
    const t = await mkUser();
    const original = audits.create.bind(audits);
    const spy = jest
      .spyOn(audits, 'create')
      .mockImplementation(((doc: unknown, ...rest: unknown[]) =>
        !Array.isArray(doc) && (doc as { action?: string }).action === 'SESSION_REVOKED'
          ? Promise.reject(new Error('audit down'))
          : (original as (...x: unknown[]) => unknown)(doc, ...rest)) as never);
    try {
      const r = await run(args(t.email), () => Promise.resolve(3));
      expect(r.result).toMatchObject({ sessions: { revoked: 3 } });
      expect(exitCodeOf(r.result)).toBe(0);
      expect(r.lines).toContain('warning: the session revoke audit event could not be written');
    } finally {
      spy.mockRestore();
    }
  });

  it('D95.7 (4) without --reset-mfa => revoker never called, sessions not_requested, sessions alive, no SESSION_REVOKED', async () => {
    const t = await mkUser();
    const [a] = await signIn(t.id);
    const revokeSessions = jest.fn(() => Promise.resolve(99));
    const r = await run(args(t.email, { resetMfa: false }), revokeSessions);
    expect(r.result).toMatchObject({ status: 'recovered', sessions: 'not_requested' });
    expect(exitCodeOf(r.result)).toBe(0);
    expect(revokeSessions).not.toHaveBeenCalled();
    expect(await sessions.get(a.id)).not.toBeNull();
    expect(await revokedAudits()).toHaveLength(0);
    expect(r.out).not.toMatch(/^(sessions|warning)/m);
  });

  it('exit code map: refused => 1', () => {
    expect(exitCodeOf({ status: 'refused', reason: 'not_confirmed' })).toBe(1);
  });
});
