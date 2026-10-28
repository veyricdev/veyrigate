import { jest } from '@jest/globals';
import { randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { Types, type Model } from 'mongoose';
import { ADMIN_LOCKED_UNTIL, UserService } from '../src/modules/identity/user.service';
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
import { seedConsent, seedOAuthUser } from './oauth-fixtures';

/**
 * Tester risk tests, run 57 (DEBT-420 lock/unlock audit order, DEBT-422 audit sort/cursor,
 * DEBT-427 cursor Date range), on the REAL app over HTTP:
 * - several admins (2 super + 2 tenant) interleaving lock/unlock in parallel, no barrier: the
 *   success trail sorted by (timestamp,_id), REPLAYED with the level rules, must end on the exact
 *   DB state (locked + level) every round; success timestamps strictly increase; follow-ups of a
 *   lock request sort after its own `LOCKED success`;
 * - same ms (one injected `now` for every write, in parallel): marks are now..now+writes-1;
 * - levels: legacy sentinel, brute-force lock, tenant cannot lift/lower a super lock;
 * - DEBT-152 with the mark ahead of the clock: failure + SESSION_REVOKED sort after their success;
 * - audit list: many events at the same ms paged at several limits == the full set (no repeat, no
 *   gap, exact order); forged cursors => 400 (never 5xx); other-tenant cursor => own rows only;
 * - exposure: `adminLockMarkAt` never in a response, an audit row or a log line.
 */
const ADMIN_SCOPE = 'openid admin.read admin.write offline_access';
const TENANT_B = 'r57t-tenant-b';
const SENTINEL = ADMIN_LOCKED_UNTIL.getTime();

type AuditRow = {
  _id: Types.ObjectId;
  eventId: string;
  action: string;
  result: string;
  reason?: string;
  actorId?: string;
  requestId?: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
};
type DbUser = { lockedUntil?: Date; adminLockLevel?: string; adminLockMarkAt?: Date };
type Op = { kind: 'lock' | 'unlock'; who: 'super1' | 'super2' | 'tenant1' | 'tenant2' };

/** Small deterministic PRNG (mulberry32) so a failing round is reproducible. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('run 57 tester: lock/unlock audit order + audit cursor over real HTTP', () => {
  let full: FullApp;
  let bff: { clientId: string; secret: string };
  const ids: Record<Op['who'], string> = { super1: '', super2: '', tenant1: '', tenant2: '' };
  const at: Record<Op['who'], string> = { super1: '', super2: '', tenant1: '', tenant2: '' };
  let auditModel: Model<Record<string, unknown>>;
  let userModel: Model<Record<string, unknown>>;
  const pino: string[] = [];
  const bodies: string[] = [];

  beforeAll(async () => {
    full = await bootFullApp({
      name: 'run57t',
      logStream: new Writable({
        write(chunk, _e, cb) {
          pino.push(String(chunk));
          cb();
        },
      }),
    });
    auditModel = full.conn.model<Record<string, unknown>>('AuditLog');
    userModel = full.conn.model<Record<string, unknown>>('User');
    bff = await seedFlowClient(full);
    for (const who of ['super1', 'super2', 'tenant1', 'tenant2'] as const) {
      ids[who] = await adminUser(who.startsWith('super') ? 'super_admin' : 'tenant_admin');
      at[who] = await login(ids[who]);
    }
  }, 90_000);

  afterAll(async () => {
    if (full) await full.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------- helpers

  async function adminUser(role: string): Promise<string> {
    const userId = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
    await full.conn
      .model('UserTenant')
      .updateOne(
        { userId: new Types.ObjectId(userId), tenantId: DEFAULT_TENANT_ID },
        { $set: { roles: [role] } },
      );
    return userId;
  }

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

  const api = async (method: 'GET' | 'POST', url: string, token: string) => {
    const res = (await full.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
    })) as InjectResponse;
    bodies.push(res.body);
    return res;
  };
  const run = (op: Op, id: string) =>
    api('POST', `/admin/users/${id}/${op.kind}`, at[op.who]).then((r) => ({ op, r }));
  const target = () => seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
  const dbUser = (id: string) => userModel.findById(id).lean<DbUser>();
  const trailOf = (id: string) =>
    auditModel
      .find({ targetId: id, action: { $in: ['ADMIN_USER_LOCKED', 'ADMIN_USER_UNLOCKED'] } })
      .sort({ timestamp: 1, _id: 1 })
      .lean<AuditRow[]>();

  type State = { locked: boolean; level: 'super_admin' | 'tenant_admin' | 'legacy' | null };
  const stateOf = (u: DbUser | null): State => {
    const locked = u?.lockedUntil?.getTime() === SENTINEL;
    if (!locked) return { locked: false, level: null };
    return {
      locked: true,
      level: (u?.adminLockLevel as State['level'] | undefined) ?? 'legacy',
    };
  };
  const isTenantActor = (actorId: string | undefined) =>
    actorId === ids.tenant1 || actorId === ids.tenant2;

  /**
   * Replay the success trail (sorted by (timestamp,_id)) with the DEBT-153 level rules; returns the
   * final state and every rule violation (tenant lifting/lowering a higher lock in trail order).
   */
  function replay(initial: State, trail: AuditRow[]) {
    const s: State = { ...initial };
    const violations: string[] = [];
    for (const e of trail.filter((r) => r.result === 'success')) {
      if (e.action === 'ADMIN_USER_LOCKED') {
        const lvl = (e.metadata as { level?: string } | undefined)?.level;
        if (lvl === 'super_admin') s.level = 'super_admin';
        else if (!(s.locked && (s.level === 'super_admin' || s.level === 'legacy')))
          s.level = 'tenant_admin';
        s.locked = true;
      } else {
        if (s.locked && s.level !== 'tenant_admin' && isTenantActor(e.actorId))
          violations.push(`tenant ${e.actorId} lifted a ${s.level} lock`);
        s.locked = false;
        s.level = null;
      }
    }
    return { state: s, violations };
  }

  // ---------------------------------------------------------------- DEBT-420 multi-admin

  describe('DEBT-420: 2 super + 2 tenant admins, lock/unlock interleaved in parallel (no barrier)', () => {
    const OPS: Op[] = [
      { kind: 'lock', who: 'super1' },
      { kind: 'unlock', who: 'tenant1' },
      { kind: 'lock', who: 'tenant2' },
      { kind: 'unlock', who: 'super2' },
      { kind: 'lock', who: 'tenant1' },
      { kind: 'unlock', who: 'super1' },
      { kind: 'lock', who: 'super2' },
      { kind: 'unlock', who: 'tenant2' },
    ];

    it('M1 12 rounds x 6..8 parallel ops (random order/subset, 3 start states) => replayed success trail == DB (locked + level), no level violation, success ts strictly increasing, follow-ups after their own success', async () => {
      const mismatches: string[] = [];
      let totalOps = 0;
      for (let round = 0; round < 12; round++) {
        const rnd = prng(5700 + round);
        const id = await target();
        const start = round % 3; // 0 = unlocked, 1 = tenant-locked, 2 = super-locked
        if (start === 1)
          expect((await run({ kind: 'lock', who: 'tenant1' }, id)).r.statusCode).toBe(200);
        if (start === 2)
          expect((await run({ kind: 'lock', who: 'super1' }, id)).r.statusCode).toBe(200);
        const preTrail = await trailOf(id);
        const initial = stateOf(await dbUser(id));
        const ops = [...OPS].sort(() => rnd() - 0.5).slice(0, 6 + (round % 3));
        totalOps += ops.length;
        const results = await Promise.all(ops.map((op) => run(op, id)));
        for (const { op, r } of results) {
          if (op.kind === 'lock') expect([op, r.statusCode]).toEqual([op, 200]);
          else expect([op, [200, 403].includes(r.statusCode)]).toEqual([op, true]);
          if (r.statusCode === 403) expect(op.who.startsWith('tenant')).toBe(true);
        }
        const db = await dbUser(id);
        const trail = await trailOf(id);
        const fresh = trail.filter((e) => !preTrail.some((p) => p._id.equals(e._id)));
        const { state, violations } = replay(initial, fresh);
        const dbState = stateOf(db);
        if (JSON.stringify(state) !== JSON.stringify(dbState))
          mismatches.push(
            `round ${round}: replay ${JSON.stringify(state)} != db ${JSON.stringify(dbState)}`,
          );
        mismatches.push(...violations.map((v) => `round ${round}: ${v}`));
        // Every lock request audits exactly one success.
        const lockCalls = ops.filter((o) => o.kind === 'lock').length;
        expect(
          fresh.filter((e) => e.action === 'ADMIN_USER_LOCKED' && e.result === 'success'),
        ).toHaveLength(lockCalls);
        // Lock/unlock success timestamps strictly increase (no tie => no reliance on _id).
        const ts = trail.filter((e) => e.result === 'success').map((e) => e.timestamp.getTime());
        for (let k = 1; k < ts.length; k++)
          if (!(ts[k] > ts[k - 1]))
            mismatches.push(`round ${round}: success ts not increasing ${ts.join(',')}`);
        expect(db?.adminLockMarkAt?.getTime()).toBeGreaterThanOrEqual(ts[ts.length - 1]);
        // Follow-ups (SESSION_REVOKED via lock) sort after the LOCKED success of the same request.
        const revoked = await auditModel
          .find({ targetId: id, action: 'SESSION_REVOKED' })
          .lean<AuditRow[]>();
        expect(revoked).toHaveLength(lockCalls + (start === 0 ? 0 : 1));
        for (const r of revoked) {
          expect(typeof r.requestId).toBe('string');
          const own = trail.find(
            (e) =>
              e.action === 'ADMIN_USER_LOCKED' &&
              e.result === 'success' &&
              e.requestId === r.requestId,
          );
          expect(own).toBeDefined();
          expect(r.timestamp.getTime()).toBeGreaterThan(own!.timestamp.getTime());
        }
      }
      expect(mismatches).toEqual([]);
      expect(totalOps).toBeGreaterThanOrEqual(72);
    });

    it('M2 same ms: 5 rounds x 7 parallel ops with ONE injected now => marks now..now+writes-1, success ts distinct in that range, replay == DB', async () => {
      const svc = full.app.get(UserService);
      const realLock = svc.adminLock.bind(svc);
      const realUnlock = svc.adminUnlock.bind(svc);
      for (let round = 0; round < 5; round++) {
        const now = new Date(Date.now() - 7 * 86_400_000 + round); // in the past: prev+1 dominates
        const lockSpy = jest
          .spyOn(svc, 'adminLock')
          .mockImplementation((sub, level) => realLock(sub, level, now));
        const writes: string[] = [];
        const unlockSpy = jest.spyOn(svc, 'adminUnlock').mockImplementation(async (sub, sup) => {
          const r = await realUnlock(sub, sup, now);
          if (r !== 'forbidden' && r !== null) writes.push('unlock');
          return r;
        });
        const id = await target();
        const rnd = prng(5757 + round);
        const ops = [...OPS].sort(() => rnd() - 0.5).slice(0, 7);
        const results = await Promise.all(ops.map((op) => run(op, id)));
        lockSpy.mockRestore();
        unlockSpy.mockRestore();
        const nWrites = ops.filter((o) => o.kind === 'lock').length + writes.length;
        for (const { op, r } of results) if (op.kind === 'lock') expect(r.statusCode).toBe(200);
        const db = await dbUser(id);
        expect(db?.adminLockMarkAt?.getTime()).toBe(now.getTime() + nWrites - 1);
        const trail = await trailOf(id);
        const ts = trail.filter((e) => e.result === 'success').map((e) => e.timestamp.getTime());
        expect(new Set(ts).size).toBe(ts.length);
        for (const t of ts) {
          expect(t).toBeGreaterThanOrEqual(now.getTime());
          expect(t).toBeLessThanOrEqual(now.getTime() + nWrites - 1);
        }
        const { state, violations } = replay({ locked: false, level: null }, trail);
        expect(violations).toEqual([]);
        expect(state).toEqual(stateOf(db));
      }
    });
  });

  // ---------------------------------------------------------------- levels

  describe('DEBT-153 levels still hold with the single-pipeline lock', () => {
    it('V1 legacy sentinel (no level): tenant lock keeps it unlevelled (bumps mark), tenant unlock 403, super unlock 200', async () => {
      const id = await target();
      await userModel.updateOne({ _id: id }, { $set: { lockedUntil: ADMIN_LOCKED_UNTIL } });
      expect((await run({ kind: 'lock', who: 'tenant1' }, id)).r.statusCode).toBe(200);
      const u = await dbUser(id);
      expect(u?.lockedUntil?.getTime()).toBe(SENTINEL);
      expect(u).not.toHaveProperty('adminLockLevel');
      expect(u?.adminLockMarkAt).toBeInstanceOf(Date);
      expect((await run({ kind: 'unlock', who: 'tenant2' }, id)).r.statusCode).toBe(403);
      expect(stateOf(await dbUser(id))).toEqual({ locked: true, level: 'legacy' });
      expect((await run({ kind: 'unlock', who: 'super2' }, id)).r.statusCode).toBe(200);
      expect(stateOf(await dbUser(id))).toEqual({ locked: false, level: null });
    });

    it('V2 brute-force lock (future, not sentinel): tenant lock => level tenant_admin, tenant unlock 200', async () => {
      const id = await target();
      await userModel.updateOne(
        { _id: id },
        { $set: { lockedUntil: new Date(Date.now() + 15 * 60_000), failedLoginCount: 5 } },
      );
      expect((await run({ kind: 'lock', who: 'tenant1' }, id)).r.statusCode).toBe(200);
      expect(stateOf(await dbUser(id))).toEqual({ locked: true, level: 'tenant_admin' });
      expect((await run({ kind: 'unlock', who: 'tenant2' }, id)).r.statusCode).toBe(200);
      expect(stateOf(await dbUser(id))).toEqual({ locked: false, level: null });
    });

    it('V3 tenant-locked + super lock => super; tenant lock after that keeps super; tenant unlock 403 x2 (no write, mark unchanged)', async () => {
      const id = await target();
      expect((await run({ kind: 'lock', who: 'tenant1' }, id)).r.statusCode).toBe(200);
      expect((await run({ kind: 'lock', who: 'super1' }, id)).r.statusCode).toBe(200);
      expect((await run({ kind: 'lock', who: 'tenant2' }, id)).r.statusCode).toBe(200);
      expect(stateOf(await dbUser(id))).toEqual({ locked: true, level: 'super_admin' });
      const mark = (await dbUser(id))?.adminLockMarkAt?.getTime();
      expect((await run({ kind: 'unlock', who: 'tenant1' }, id)).r.statusCode).toBe(403);
      expect((await run({ kind: 'unlock', who: 'tenant2' }, id)).r.statusCode).toBe(403);
      expect((await dbUser(id))?.adminLockMarkAt?.getTime()).toBe(mark);
      expect(stateOf(await dbUser(id))).toEqual({ locked: true, level: 'super_admin' });
    });
  });

  // ---------------------------------------------------------------- DEBT-152 order

  it('O1 DEBT-152 with the mark 1h ahead: revoke fault => failure sorts after its LOCKED success; retry => SESSION_REVOKED after the retry success; trail success,failure,success', async () => {
    const id = await target();
    await userModel.updateOne(
      { _id: id },
      { $set: { adminLockMarkAt: new Date(Date.now() + 3_600_000) } },
    );
    jest
      .spyOn(full.app.get(SessionService), 'revokeAllForUser')
      .mockRejectedValueOnce(new Error('redis down r57'));
    const first = await run({ kind: 'lock', who: 'tenant1' }, id);
    expect(first.r.statusCode).toBeGreaterThanOrEqual(500);
    expect(first.r.body).not.toContain('redis down r57');
    expect((await run({ kind: 'lock', who: 'tenant1' }, id)).r.statusCode).toBe(200);
    const trail = await trailOf(id);
    expect(trail.map((e) => `${e.action}:${e.result}:${e.reason ?? ''}`)).toEqual([
      'ADMIN_USER_LOCKED:success:',
      'ADMIN_USER_LOCKED:failure:revoke_failed',
      'ADMIN_USER_LOCKED:success:',
    ]);
    expect(trail[0].requestId).toBe(trail[1].requestId);
    expect(trail[1].timestamp.getTime()).toBeGreaterThan(trail[0].timestamp.getTime());
    const revoked = await auditModel
      .find({ targetId: id, action: 'SESSION_REVOKED' })
      .lean<AuditRow[]>();
    expect(revoked).toHaveLength(1);
    expect(revoked[0].requestId).toBe(trail[2].requestId);
    expect(revoked[0].timestamp.getTime()).toBeGreaterThan(trail[2].timestamp.getTime());
    // The lock audit times are the marks (ahead of the clock), not Node time.
    expect(trail[0].timestamp.getTime()).toBeGreaterThan(Date.now() + 3_000_000);
  });

  // ---------------------------------------------------------------- DEBT-422 audit list

  describe('DEBT-422: audit list sort/cursor (timestamp desc, _id desc)', () => {
    const forged = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const rawB64 = (s: string) => Buffer.from(s).toString('base64url');

    /** 36 events of tenant A across 3 ms (12 each) inserted in SHUFFLED _id order with random eventIds, + B/no-tenant noise. */
    async function seedMany() {
      const actor = `r57t-many-${randomUUID()}`;
      const base = Date.now() - 20 * 60_000;
      const rows: Record<string, unknown>[] = [];
      for (let k = 0; k < 36; k++)
        rows.push({
          _id: new Types.ObjectId(),
          eventId: randomUUID(),
          timestamp: new Date(base + (k % 3)),
          actorType: 'admin',
          actorId: actor,
          tenantId: DEFAULT_TENANT_ID,
          action: 'ADMIN_CLIENT_UPDATED',
          result: 'success',
        });
      for (let k = 0; k < 6; k++)
        rows.push({
          _id: new Types.ObjectId(),
          eventId: randomUUID(),
          timestamp: new Date(base + (k % 3)),
          actorType: 'admin',
          actorId: actor,
          ...(k % 2 ? { tenantId: TENANT_B } : {}),
          action: 'ADMIN_CLIENT_UPDATED',
          result: 'success',
        });
      const rnd = prng(422);
      rows.sort(() => rnd() - 0.5);
      for (const r of rows) await auditModel.create(r); // one by one: insertion order != _id order
      const expected = rows
        .filter((r) => r.tenantId === DEFAULT_TENANT_ID)
        .sort((a, b) => {
          const dt = (b.timestamp as Date).getTime() - (a.timestamp as Date).getTime();
          if (dt) return dt;
          const ha = (a._id as Types.ObjectId).toHexString();
          const hb = (b._id as Types.ObjectId).toHexString();
          return hb < ha ? -1 : hb > ha ? 1 : 0;
        })
        .map((r) => r.eventId as string);
      return { actor, expected, base };
    }

    async function walk(actor: string, limit: number, token: string) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await api(
          'GET',
          `/admin/audit?actorId=${actor}&limit=${limit}${cursor ? `&after=${cursor}` : ''}`,
          token,
        );
        expect(res.statusCode).toBe(200);
        const body = res.json<{ items: { eventId: string }[]; nextCursor: string | null }>();
        expect(body.items.length).toBeLessThanOrEqual(limit);
        for (const item of body.items) expect(item).not.toHaveProperty('_id');
        seen.push(...body.items.map((e) => e.eventId));
        cursor = body.nextCursor;
        if (cursor) {
          const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<
            string,
            unknown
          >;
          expect(Object.keys(decoded).sort()).toEqual(['i', 't']);
          expect(decoded.i).toMatch(/^[0-9a-f]{24}$/);
        }
      } while (cursor && ++pages < 100);
      return seen;
    }

    it('P1 36 tenant-A events over 3 ms (shuffled insert) paged at limit 1/2/5/7/11/12/36/100 == full sorted set, no repeat, no gap; B/no-tenant never shown', async () => {
      const { actor, expected } = await seedMany();
      const token = at.tenant1;
      for (const limit of [1, 2, 5, 7, 11, 12, 36, 100]) {
        const seen = await walk(actor, limit, token);
        expect([limit, seen]).toEqual([limit, expected]);
      }
      // A super_admin of the same tenant sees the same list.
      expect(await walk(actor, 5, at.super2)).toEqual(expected);
    });

    it('P2 writes between pages (same ms as the cursor, smaller and larger _id) => no repeat, no gap of the original set', async () => {
      const { actor, expected, base } = await seedMany();
      const token = at.tenant2;
      const first = await api('GET', `/admin/audit?actorId=${actor}&limit=10`, token);
      const p1 = first.json<{ items: { eventId: string }[]; nextCursor: string }>();
      const cur = JSON.parse(Buffer.from(p1.nextCursor, 'base64url').toString('utf8')) as {
        t: number;
        i: string;
      };
      const mk = (_id: Types.ObjectId, eventId: string) => ({
        _id,
        eventId,
        timestamp: new Date(cur.t),
        actorType: 'admin',
        actorId: actor,
        tenantId: DEFAULT_TENANT_ID,
        action: 'ADMIN_CLIENT_UPDATED',
        result: 'success',
      });
      const smaller = new Types.ObjectId('0'.repeat(23) + '1');
      await auditModel.create([
        mk(new Types.ObjectId(), 'newer-same-ms'),
        mk(smaller, 'older-same-ms'),
      ]);
      const rest: string[] = [];
      let cursor: string | null = p1.nextCursor;
      while (cursor) {
        const res = await api(
          'GET',
          `/admin/audit?actorId=${actor}&limit=10&after=${cursor}`,
          token,
        );
        const b = res.json<{ items: { eventId: string }[]; nextCursor: string | null }>();
        rest.push(...b.items.map((e) => e.eventId));
        cursor = b.nextCursor;
      }
      const all = [...p1.items.map((e) => e.eventId), ...rest];
      expect(new Set(all).size).toBe(all.length);
      expect(all.filter((e) => !e.endsWith('same-ms'))).toEqual(expected);
      expect(all).toContain('older-same-ms'); // sorts after the cursor => shown once
      expect(all).not.toContain('newer-same-ms'); // sorts before the cursor => not on later pages
      expect(base).toBeGreaterThan(0);
    });

    it('P3 forged cursors => 400 invalid_request, never 5xx; boundary/extra keys => 200', async () => {
      const hex = 'b'.repeat(24);
      const bad = [
        forged({ t: 0, e: 'x' }), // legacy {t,e}
        forged({ t: 1700000000000, e: randomUUID() }),
        forged({ t: '1', i: hex }),
        forged({ t: true, i: hex }),
        forged({ t: null, i: hex }),
        forged({ t: -1, i: hex }),
        forged({ t: -0.5, i: hex }),
        forged({ t: 1.5, i: hex }),
        forged({ t: 8.64e15 + 1, i: hex }),
        forged({ t: 8.64e15 + 2, i: hex }),
        forged({ t: 9e15, i: hex }),
        forged({ t: Number.MAX_SAFE_INTEGER, i: hex }),
        forged({ t: 1e300, i: hex }),
        forged({ t: 1, i: hex.toUpperCase() }),
        forged({ t: 1, i: `B${'b'.repeat(23)}` }),
        forged({ t: 1, i: 'b'.repeat(23) }),
        forged({ t: 1, i: 'b'.repeat(25) }),
        forged({ t: 1, i: '' }),
        forged({ t: 1, i: ` ${'b'.repeat(23)}` }),
        forged({ t: 1, i: `${hex}\n` }),
        forged({ t: 1, i: { $gt: '' } }),
        forged({ t: 1, i: { $ne: null } }),
        forged({ t: 1, i: [hex] }),
        forged({ t: 1, i: 1 }),
        forged({ t: 1, i: null }),
        forged({ t: { $gt: 0 }, i: hex }),
        forged([1, hex]),
        forged('x'),
        rawB64(`{"__proto__":{"i":"${hex}"},"t":1}`),
        rawB64(`{"constructor":{"i":"${hex}"},"t":1}`),
        rawB64('{"t":1,"i":"' + hex + '"'), // truncated JSON
        rawB64('not json'),
      ];
      for (const after of bad) {
        const res = await api('GET', `/admin/audit?after=${after}`, at.tenant1);
        expect([after, res.statusCode, res.json()]).toEqual([
          after,
          400,
          { error: 'invalid_request', error_description: 'invalid cursor' },
        ]);
      }
      // Rejected by the DTO (not base64url / too long / empty): 400, never 5xx.
      for (const after of ['%24gt', 'a+b/c=', 'x'.repeat(513), '']) {
        const res = await api('GET', `/admin/audit?after=${after}`, at.tenant1);
        expect([after, res.statusCode]).toEqual([after, 400]);
      }
      // Accepted: biggest valid Date, t=0, extra keys ignored (still only `t`+`i` drive the query).
      for (const after of [
        forged({ t: 8.64e15, i: hex }),
        forged({ t: 0, i: hex }),
        forged({ t: 1, i: hex, e: 'legacy', tenantId: TENANT_B }),
      ]) {
        const res = await api('GET', `/admin/audit?after=${after}`, at.tenant1);
        expect([after, res.statusCode]).toEqual([after, 200]);
      }
    });

    it('P4 cursor built from a tenant-B row, paged by tenant A at limit 3 => only tenant A rows, exactly those after the position', async () => {
      const { actor, expected } = await seedMany();
      const bRow = await auditModel
        .findOne({ actorId: actor, tenantId: TENANT_B })
        .lean<{ _id: Types.ObjectId; timestamp: Date }>();
      expect(bRow).not.toBeNull();
      const cursor = forged({ t: bRow!.timestamp.getTime(), i: bRow!._id.toHexString() });
      const seen: string[] = [];
      let after: string | null = cursor;
      while (after) {
        const res = await api(
          'GET',
          `/admin/audit?actorId=${actor}&limit=3&after=${after}`,
          at.tenant1,
        );
        expect(res.statusCode).toBe(200);
        const b = res.json<{ items: { eventId: string }[]; nextCursor: string | null }>();
        seen.push(...b.items.map((e) => e.eventId));
        after = b.nextCursor;
      }
      const all = await auditModel
        .find({ actorId: actor, tenantId: DEFAULT_TENANT_ID })
        .lean<{ _id: Types.ObjectId; eventId: string; timestamp: Date }[]>();
      const pos = (r: { _id: Types.ObjectId; timestamp: Date }) =>
        r.timestamp.getTime() < bRow!.timestamp.getTime() ||
        (r.timestamp.getTime() === bRow!.timestamp.getTime() &&
          r._id.toHexString() < bRow!._id.toHexString());
      const want = new Set(all.filter(pos).map((r) => r.eventId));
      expect(seen).toEqual(expected.filter((e) => want.has(e)));
    });
  });

  // ---------------------------------------------------------------- exposure (last)

  it('X1 exposure: adminLockMarkAt never in any response (lock/unlock/get/list/audit), audit row or log line', async () => {
    const id = await target();
    await run({ kind: 'lock', who: 'super1' }, id);
    await run({ kind: 'unlock', who: 'super1' }, id);
    await api('GET', `/admin/users/${id}`, at.super1);
    await api('GET', '/admin/users?limit=100', at.super1);
    await api('GET', `/admin/audit?targetId=${id}&limit=100`, at.super1);
    expect(bodies.length).toBeGreaterThan(100);
    for (const b of bodies) expect(b).not.toContain('adminLockMarkAt');
    const rows = await auditModel.find({}).lean();
    expect(JSON.stringify(rows)).not.toContain('adminLockMarkAt');
    expect(pino.join('')).not.toContain('adminLockMarkAt');
    // No JWT / bearer leaked into logs either.
    expect(pino.join('')).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./);
  });
});
