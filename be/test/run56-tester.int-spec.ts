import { jest } from '@jest/globals';
import IORedis from 'ioredis';
import { randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { Types, type Model } from 'mongoose';
import { AuthenticationService } from '../src/modules/authentication/authentication.service';
import { ClientCredentialService } from '../src/modules/clients/client-credential.service';
import { ClientService } from '../src/modules/clients/client.service';
import { ADMIN_LOCKED_UNTIL, UserService } from '../src/modules/identity/user.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { SESSION_COOKIE } from '../src/modules/sessions/session.cookie';
import { SessionService } from '../src/modules/sessions/session.service';
import {
  authorizeCode,
  bootFullApp,
  closeFullApp,
  FULL_APP_BOOT_TIMEOUT_MS,
  FLOW_ADMIN_AUD,
  FLOW_API_AUD,
  FLOW_REDIRECT,
  FULL_APP_ISSUER,
  formPost,
  seedFlowClient,
  type FullApp,
  type InjectResponse,
} from './full-app';
import { seedConsent, seedOAuthUser } from './oauth-fixtures';

/**
 * Tester risk tests, run 56 (admin races + disable client), on the REAL app over HTTP:
 * - DEBT-166: secret issue/rotate by tenant_admin racing a super_admin admin grant, barrier in
 *   BOTH orders (tenant held / super held between its revoke passes) + unbarriered rounds:
 *   never a usable plaintext on an admin-capable client, exactly one audit per attempt;
 * - DEBT-147/153: lock levels, legacy sentinel, brute-force lock, N parallel unlocks, lock || unlock
 *   (trail must end on the DB state), super lock || tenant unlock;
 * - DEBT-209/156: disable -> enable kills code / AT / RT / consent context / login context created
 *   before; artefacts created after enable + margin live; a never-disabled client is untouched.
 */
const ADMIN_SCOPE = 'openid admin.read admin.write offline_access';
const API_SCOPE = 'openid offline_access api.read';
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./;

type Auth = { clientId: string; secret: string };
type Tokens = { access_token: string; refresh_token: string };
type AuditRow = {
  action: string;
  result: string;
  reason?: string;
  timestamp: Date;
  _id: Types.ObjectId;
  metadata?: Record<string, unknown>;
};

function barrier() {
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => (reach = r));
  const gate = new Promise<void>((r) => (release = r));
  return { reached, gate, reach, release };
}

describe('run 56 tester: admin races + disable/enable over real HTTP', () => {
  let full: FullApp;
  let booting: Promise<FullApp> | undefined;
  let redis: IORedis;
  let bff: Auth; // admin-capable BFF (aud=admin tokens)
  let rs: Auth; // resource server allowed to introspect `api`
  let superId = '';
  let tadminId = '';
  let superAt = '';
  let tadminAt = '';
  let clientModel: Model<Record<string, unknown>>;
  let auditModel: Model<Record<string, unknown>>;
  let credModel: Model<Record<string, unknown>>;
  let userModel: Model<Record<string, unknown>>;
  const pino: string[] = [];
  const plaintexts: string[] = [];
  let n = 0;

  beforeAll(async () => {
    booting = bootFullApp({
      name: 'run56t',
      logStream: new Writable({
        write(chunk, _e, cb) {
          pino.push(String(chunk));
          cb();
        },
      }),
    });
    full = await booting;
    redis = new IORedis(process.env.TEST_REDIS_URL ?? 'redis://localhost:6479', {
      maxRetriesPerRequest: 1,
    });
    clientModel = full.conn.model<Record<string, unknown>>('Client');
    auditModel = full.conn.model<Record<string, unknown>>('AuditLog');
    credModel = full.conn.model<Record<string, unknown>>('ClientCredential');
    userModel = full.conn.model<Record<string, unknown>>('User');
    bff = await seedFlowClient(full);
    rs = await mkConfidential(['api']);
    superId = await adminUser('super_admin');
    tadminId = await adminUser('tenant_admin');
    superAt = (await login(superId, bff, FLOW_ADMIN_AUD, ADMIN_SCOPE)).access_token;
    tadminAt = (await login(tadminId, bff, FLOW_ADMIN_AUD, ADMIN_SCOPE)).access_token;
  }, FULL_APP_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await redis?.quit();
    await closeFullApp(booting);
  }, FULL_APP_BOOT_TIMEOUT_MS);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------- helpers

  async function mkConfidential(allowedResources: string[]): Promise<Auth> {
    const clientId = `r56t-conf-${++n}-${randomUUID()}`;
    await full.app.get(ClientService).create({
      clientId,
      clientType: 'confidential',
      tokenEndpointAuthMethod: 'client_secret_basic',
      redirectUris: [FLOW_REDIRECT],
      allowedResources,
      scopes: ['openid', 'offline_access', 'api.read'],
      grantTypes: ['authorization_code', 'refresh_token'],
      tenantId: DEFAULT_TENANT_ID,
    });
    const { secret } = await full.app.get(ClientCredentialService).createSecret(clientId);
    return { clientId, secret };
  }

  /** Confidential client WITHOUT any secret, tenant_admin-modifiable (no `admin`). */
  async function mkBareConfidential(): Promise<string> {
    const clientId = `r56t-bare-${++n}-${randomUUID()}`;
    await full.app.get(ClientService).create({
      clientId,
      clientType: 'confidential',
      tokenEndpointAuthMethod: 'client_secret_basic',
      redirectUris: [FLOW_REDIRECT],
      allowedResources: ['api'],
      scopes: ['openid', 'offline_access', 'api.read'],
      grantTypes: ['authorization_code', 'refresh_token'],
      tenantId: DEFAULT_TENANT_ID,
    });
    return clientId;
  }

  async function mkPublic(): Promise<string> {
    const clientId = `r56t-pub-${++n}-${randomUUID()}`;
    await full.app.get(ClientService).create({
      clientId,
      clientType: 'public',
      tokenEndpointAuthMethod: 'none',
      redirectUris: [FLOW_REDIRECT],
      allowedResources: [],
      scopes: ['openid', 'profile'],
      tenantId: DEFAULT_TENANT_ID,
    });
    return clientId;
  }

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

  const newSession = async (userId: string) =>
    (await full.app.get(SessionService).create(userId, DEFAULT_TENANT_ID)).id;

  async function codeFor(userId: string, client: Auth, resource: string, scope: string) {
    await seedConsent(full.conn, {
      userId,
      clientId: client.clientId,
      resource,
      scopes: scope.split(' '),
    });
    const verifier = randomBytes(32).toString('base64url');
    const code = await authorizeCode(full, {
      ...client,
      sessionId: await newSession(userId),
      resource,
      scope,
      verifier,
    });
    return { code, verifier };
  }

  const exchange = (client: Auth, c: { code: string; verifier: string }) =>
    formPost(full, '/token', client, {
      grant_type: 'authorization_code',
      code: c.code,
      redirect_uri: FLOW_REDIRECT,
      code_verifier: c.verifier,
    });

  async function login(userId: string, client: Auth, resource: string, scope: string) {
    const res = await exchange(client, await codeFor(userId, client, resource, scope));
    expect(res.statusCode).toBe(200);
    return res.json<Tokens>();
  }

  const api = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    at: string,
    payload?: object,
  ) =>
    full.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${at}` },
      ...(payload ? { payload } : {}),
    }) as Promise<InjectResponse>;

  const introspect = async (at: string) =>
    (await formPost(full, '/introspect', rs, { token: at })).json<Record<string, unknown>>();
  const userinfo = (at: string) =>
    full.app.inject({
      method: 'GET',
      url: '/userinfo',
      headers: { authorization: `Bearer ${at}` },
    });

  /** 401 = client auth failed (secret dead); 400 = auth passed (garbage grant). */
  const secretStatus = async (clientId: string, secret: string) =>
    (
      await formPost(
        full,
        '/token',
        { clientId, secret },
        { grant_type: 'refresh_token', refresh_token: 'x' },
      )
    ).statusCode;

  const audits = (filter: Record<string, unknown>) =>
    auditModel.find(filter).sort({ timestamp: 1, _id: 1 }).lean<AuditRow[]>();

  // ---------------------------------------------------------------- DEBT-166

  describe('DEBT-166: tenant_admin secret issue/rotate || super_admin admin grant', () => {
    const grant = (id: string) =>
      api('PATCH', `/admin/clients/${id}`, superAt, { allowedResources: ['api', 'admin'] });
    const issue = (id: string) => api('POST', `/admin/clients/${id}/secrets`, tadminAt);
    const liveCreds = (id: string) => credModel.countDocuments({ clientId: id, revokedAt: null });
    const secretAudits = (id: string) =>
      audits({ targetId: id, action: { $in: ['CLIENT_SECRET_CREATED', 'CLIENT_SECRET_ROTATED'] } });

    it('R1 ROTATE held after insert, grant completes, released => 403, no plaintext, old+new dead, exactly 1 failure audit', async () => {
      const id = await mkBareConfidential();
      const first = await issue(id);
      expect(first.statusCode).toBe(201);
      const v1 = first.json<{ clientSecret: string }>().clientSecret;
      plaintexts.push(v1);
      expect(await secretStatus(id, v1)).toBe(400);

      const svc = full.app.get(ClientCredentialService);
      const real = svc.rotateSecret.bind(svc);
      const b = barrier();
      jest.spyOn(svc, 'rotateSecret').mockImplementationOnce(async (cid) => {
        const issued = await real(cid);
        b.reach();
        await b.gate;
        return issued;
      });
      const pending = issue(id);
      await b.reached;
      expect((await grant(id)).statusCode).toBe(200);
      b.release();
      const res = await pending;
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('forbidden');
      expect(res.body).not.toContain('clientSecret');
      expect(await liveCreds(id)).toBe(0);
      expect(await secretStatus(id, v1)).toBe(401);
      const rows = (await secretAudits(id)).filter((r) => r.action === 'CLIENT_SECRET_ROTATED');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        result: 'failure',
        reason: 'admin_granted_concurrently',
        metadata: { version: 2 },
      });
    });

    it('R2 super_admin held between revoke#1 and the update; tenant issue completes (201) => after the grant that plaintext is dead; 1 success audit', async () => {
      const id = await mkBareConfidential();
      const svc = full.app.get(ClientCredentialService);
      const real = svc.revokeAll.bind(svc);
      const b = barrier();
      jest
        .spyOn(svc, 'revokeAll')
        .mockImplementationOnce(async (...args: Parameters<typeof real>) => {
          const r = await real(...args);
          b.reach();
          await b.gate;
          return r;
        });
      const pendingGrant = grant(id);
      await b.reached;
      const res = await issue(id);
      expect(res.statusCode).toBe(201);
      const secret = res.json<{ clientSecret: string }>().clientSecret;
      plaintexts.push(secret);
      expect(await secretStatus(id, secret)).toBe(400); // live while not admin-capable
      b.release();
      expect((await pendingGrant).statusCode).toBe(200);
      expect(await secretStatus(id, secret)).toBe(401); // killed by revoke#2
      expect(await liveCreds(id)).toBe(0);
      const rows = await secretAudits(id);
      expect(rows.map((r) => `${r.action}:${r.result}`)).toEqual(['CLIENT_SECRET_CREATED:success']);
    });

    it('R3 tenant held before insert AND super held after update (before revoke#2): tenant re-read sees admin => 403 + 1 failure audit; nothing alive', async () => {
      const id = await mkBareConfidential();
      const creds = full.app.get(ClientCredentialService);
      const realRotate = creds.rotateSecret.bind(creds);
      const realRevokeAll = creds.revokeAll.bind(creds);
      const t = barrier();
      const s = barrier();
      jest.spyOn(creds, 'rotateSecret').mockImplementationOnce(async (cid) => {
        t.reach();
        await t.gate;
        return realRotate(cid);
      });
      jest
        .spyOn(creds, 'revokeAll')
        .mockImplementationOnce((...a: Parameters<typeof realRevokeAll>) => realRevokeAll(...a))
        .mockImplementationOnce(async (...a: Parameters<typeof realRevokeAll>) => {
          s.reach();
          await s.gate;
          return realRevokeAll(...a);
        });
      const pendingIssue = issue(id);
      await t.reached;
      const pendingGrant = grant(id);
      await s.reached; // update applied, revoke#2 not yet
      t.release();
      const res = await pendingIssue;
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('clientSecret');
      expect(await liveCreds(id)).toBe(0); // self-revoked before revoke#2 ran
      s.release();
      expect((await pendingGrant).statusCode).toBe(200);
      expect(await liveCreds(id)).toBe(0);
      const rows = await secretAudits(id);
      expect(rows.map((r) => `${r.action}:${r.result}:${r.reason}`)).toEqual([
        'CLIENT_SECRET_CREATED:failure:admin_granted_concurrently',
      ]);
    });

    it('R4 unbarriered: 10 rounds issue || grant => any 201 plaintext is dead afterwards, 0 live versions, audits consistent', async () => {
      const outcomes: number[] = [];
      for (let i = 0; i < 10; i++) {
        const id = await mkBareConfidential();
        const [ri, rg] = await Promise.all([issue(id), grant(id)]);
        expect(rg.statusCode).toBe(200);
        expect([201, 403]).toContain(ri.statusCode);
        outcomes.push(ri.statusCode);
        const rows = await secretAudits(id);
        const success = rows.filter((r) => r.result === 'success').length;
        const failure = rows.filter((r) => r.result === 'failure').length;
        if (ri.statusCode === 201) {
          const secret = ri.json<{ clientSecret: string }>().clientSecret;
          plaintexts.push(secret);
          expect(await secretStatus(id, secret)).toBe(401);
          expect([success, failure]).toEqual([1, 0]);
        } else {
          expect(ri.body).not.toContain('clientSecret');
          expect(success).toBe(0);
          expect(failure).toBeLessThanOrEqual(1);
        }
        expect(await liveCreds(id)).toBe(0);
      }
      // informational only (scheduling decides the mix)
      expect(outcomes).toHaveLength(10);
    });
  });

  // ---------------------------------------------------------------- DEBT-147/153

  describe('DEBT-147/153: lock levels + atomic unlock audit', () => {
    const lock = (id: string, at: string) => api('POST', `/admin/users/${id}/lock`, at);
    const unlock = (id: string, at: string) => api('POST', `/admin/users/${id}/unlock`, at);
    const target = () => seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
    const dbUser = (id: string) =>
      userModel.findById(id).lean<{
        lockedUntil?: Date;
        adminLockLevel?: string;
        failedLoginCount?: number;
        adminLockMarkAt?: Date;
      }>();
    const lockTrail = (id: string) =>
      audits({ targetId: id, action: { $in: ['ADMIN_USER_LOCKED', 'ADMIN_USER_UNLOCKED'] } });
    const isLocked = (u: { lockedUntil?: Date } | null) =>
      u?.lockedUntil?.getTime() === ADMIN_LOCKED_UNTIL.getTime();

    it('L1 super lock => tenant unlock 403 + failure audit; tenant lock keeps level super; super unlock 200 + 1 success', async () => {
      const id = await target();
      expect((await lock(id, superAt)).statusCode).toBe(200);
      const denied = await unlock(id, tadminAt);
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error).toBe('forbidden');
      expect(isLocked(await dbUser(id))).toBe(true);
      const markBefore = (await dbUser(id))?.adminLockMarkAt?.getTime() ?? 0;
      expect((await lock(id, tadminAt)).statusCode).toBe(200);
      expect((await dbUser(id))?.adminLockLevel).toBe('super_admin');
      // run 57: the tenant no-op lock still writes, so its mark (= its audit time) moves forward.
      expect((await dbUser(id))?.adminLockMarkAt?.getTime()).toBeGreaterThan(markBefore);
      expect((await unlock(id, tadminAt)).statusCode).toBe(403);
      expect((await unlock(id, superAt)).statusCode).toBe(200);
      const u = await dbUser(id);
      expect(u?.lockedUntil).toBeUndefined();
      expect(u?.adminLockLevel).toBeUndefined();
      const trail = await lockTrail(id);
      expect(trail.map((r) => `${r.action}:${r.result}:${r.reason ?? ''}`)).toEqual([
        'ADMIN_USER_LOCKED:success:',
        'ADMIN_USER_UNLOCKED:failure:locked_by_super_admin',
        'ADMIN_USER_LOCKED:success:',
        'ADMIN_USER_UNLOCKED:failure:locked_by_super_admin',
        'ADMIN_USER_UNLOCKED:success:',
      ]);
    });

    it('L2 legacy sentinel without level => tenant 403; super 200', async () => {
      const id = await target();
      await userModel.updateOne({ _id: id }, { $set: { lockedUntil: ADMIN_LOCKED_UNTIL } });
      expect((await unlock(id, tadminAt)).statusCode).toBe(403);
      expect(isLocked(await dbUser(id))).toBe(true);
      expect((await unlock(id, superAt)).statusCode).toBe(200);
      expect((await dbUser(id))?.lockedUntil).toBeUndefined();
    });

    it('L3 brute-force lock (no level) => tenant_admin unlock 200, counter 0, 1 success audit', async () => {
      const id = await target();
      await userModel.updateOne(
        { _id: id },
        { $set: { lockedUntil: new Date(Date.now() + 15 * 60_000), failedLoginCount: 5 } },
      );
      expect((await unlock(id, tadminAt)).statusCode).toBe(200);
      const u = await dbUser(id);
      expect(u?.lockedUntil).toBeUndefined();
      expect(u?.failedLoginCount).toBe(0);
      expect((await lockTrail(id)).map((r) => `${r.action}:${r.result}`)).toEqual([
        'ADMIN_USER_UNLOCKED:success',
      ]);
    });

    it('L4 5 rounds x 8 parallel unlocks (super+tenant mixed) after a tenant lock => all 200, exactly 1 UNLOCKED success per round', async () => {
      for (let i = 0; i < 5; i++) {
        const id = await target();
        expect((await lock(id, tadminAt)).statusCode).toBe(200);
        const res = await Promise.all(
          Array.from({ length: 8 }, (_, k) => unlock(id, k % 2 ? superAt : tadminAt)),
        );
        expect(res.map((r) => r.statusCode)).toEqual(Array(8).fill(200));
        expect(
          await auditModel.countDocuments({
            targetId: id,
            action: 'ADMIN_USER_UNLOCKED',
            result: 'success',
          }),
        ).toBe(1);
        expect((await dbUser(id))?.lockedUntil).toBeUndefined();
      }
    });

    it('L5 lock written but held before its audit; super unlock completes; released => trail must end on the DB state (unlocked)', async () => {
      const id = await target();
      const auth = full.app.get(AuthenticationService);
      const real = auth.revokeAllUserCredentials.bind(auth);
      const b = barrier();
      jest
        .spyOn(auth, 'revokeAllUserCredentials')
        .mockImplementationOnce(async (...a: Parameters<typeof real>) => {
          b.reach();
          await b.gate;
          return real(...a);
        });
      const pendingLock = lock(id, superAt);
      await b.reached; // adminLock already wrote the sentinel
      expect(isLocked(await dbUser(id))).toBe(true);
      expect((await unlock(id, superAt)).statusCode).toBe(200);
      b.release();
      expect((await pendingLock).statusCode).toBe(200);
      const u = await dbUser(id);
      const trail = (await lockTrail(id)).filter((r) => r.result === 'success');
      const last = trail[trail.length - 1];
      // DB truth: unlocked. The trail's last success event must say so.
      expect(isLocked(u)).toBe(false);
      expect(trail.filter((r) => r.action === 'ADMIN_USER_UNLOCKED')).toHaveLength(1);
      expect(last.action).toBe('ADMIN_USER_UNLOCKED');
    });

    it('L6 10 rounds super lock || super unlock (from tenant-locked) => final DB state == last success event of the trail', async () => {
      const mismatches: string[] = [];
      for (let i = 0; i < 10; i++) {
        const id = await target();
        expect((await lock(id, tadminAt)).statusCode).toBe(200);
        const [rl, ru] = await Promise.all([lock(id, superAt), unlock(id, superAt)]);
        expect(rl.statusCode).toBe(200);
        expect(ru.statusCode).toBe(200);
        const locked = isLocked(await dbUser(id));
        const trail = (await lockTrail(id)).filter((r) => r.result === 'success');
        const last = trail[trail.length - 1].action;
        if ((last === 'ADMIN_USER_LOCKED') !== locked)
          mismatches.push(`round ${i}: db locked=${locked}, trail ends ${last}`);
      }
      expect(mismatches).toEqual([]);
      // DEBT-448: 9.3-10.7 s under a 28-thread CPU load (default 20 s) => ~2x.
    }, 25_000);

    it('L7 8 rounds super lock || tenant unlock on a tenant-locked user => always ends locked at level super_admin', async () => {
      for (let i = 0; i < 8; i++) {
        const id = await target();
        expect((await lock(id, tadminAt)).statusCode).toBe(200);
        const [rl, ru] = await Promise.all([lock(id, superAt), unlock(id, tadminAt)]);
        expect(rl.statusCode).toBe(200);
        expect([200, 403]).toContain(ru.statusCode);
        const u = await dbUser(id);
        expect(isLocked(u)).toBe(true);
        expect(u?.adminLockLevel).toBe('super_admin');
      }
    });

    it('L8 (DEBT-423) super lock twice => 2 LOCKED success + 2 SESSION_REVOKED {scope:all, via:lock}', async () => {
      const id = await target();
      expect((await lock(id, superAt)).statusCode).toBe(200);
      expect((await lock(id, superAt)).statusCode).toBe(200);
      const locked = await audits({ targetId: id, action: 'ADMIN_USER_LOCKED', result: 'success' });
      const revoked = await audits({ targetId: id, action: 'SESSION_REVOKED', result: 'success' });
      expect(locked).toHaveLength(2);
      expect(revoked).toHaveLength(2);
      for (const r of revoked) expect(r.metadata).toMatchObject({ scope: 'all', via: 'lock' });
    });
  });

  // ---------------------------------------------------------------- run 57 (DEBT-420)

  describe('run 57 (DEBT-420): lock/unlock audit timestamp = per-user mark of the write', () => {
    const lock = (id: string, at: string) => api('POST', `/admin/users/${id}/lock`, at);
    const unlock = (id: string, at: string) => api('POST', `/admin/users/${id}/unlock`, at);
    const target = () => seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
    const markOf = async (id: string) =>
      (await userModel.findById(id).lean<{ adminLockMarkAt?: Date }>())?.adminLockMarkAt;
    const isLocked = async (id: string) =>
      (await userModel.findById(id).lean<{ lockedUntil?: Date }>())?.lockedUntil?.getTime() ===
      ADMIN_LOCKED_UNTIL.getTime();
    const successTrail = (id: string) =>
      audits({
        targetId: id,
        action: { $in: ['ADMIN_USER_LOCKED', 'ADMIN_USER_UNLOCKED'] },
        result: 'success',
      });

    it('(b) lock written and held BEFORE its audit; super unlock completes; released => DB unlocked, trail ends UNLOCKED, unlock ts == DB mark', async () => {
      const id = await target();
      const svc = full.app.get(UserService);
      const real = svc.adminLock.bind(svc);
      const b = barrier();
      jest.spyOn(svc, 'adminLock').mockImplementationOnce(async (...a) => {
        const r = await real(...a);
        b.reach();
        await b.gate;
        return r;
      });
      const pendingLock = lock(id, superAt);
      await b.reached;
      expect(await isLocked(id)).toBe(true);
      expect((await unlock(id, superAt)).statusCode).toBe(200);
      b.release();
      expect((await pendingLock).statusCode).toBe(200);
      expect(await isLocked(id)).toBe(false);
      const trail = await successTrail(id);
      expect(trail.map((r) => r.action)).toEqual(['ADMIN_USER_LOCKED', 'ADMIN_USER_UNLOCKED']);
      expect(trail[1].timestamp.getTime()).toBe((await markOf(id))?.getTime());
    });

    it('(c) unlock written and held BEFORE its audit; super lock completes; released => DB locked, trail ends LOCKED, lock ts == DB mark', async () => {
      const id = await target();
      expect((await lock(id, tadminAt)).statusCode).toBe(200);
      const svc = full.app.get(UserService);
      const real = svc.adminUnlock.bind(svc);
      const b = barrier();
      jest.spyOn(svc, 'adminUnlock').mockImplementationOnce(async (...a) => {
        const r = await real(...a);
        b.reach();
        await b.gate;
        return r;
      });
      const pendingUnlock = unlock(id, superAt);
      await b.reached;
      expect(await isLocked(id)).toBe(false);
      expect((await lock(id, superAt)).statusCode).toBe(200);
      b.release();
      expect((await pendingUnlock).statusCode).toBe(200);
      expect(await isLocked(id)).toBe(true);
      const trail = await successTrail(id);
      expect(trail.map((r) => r.action)).toEqual([
        'ADMIN_USER_LOCKED',
        'ADMIN_USER_UNLOCKED',
        'ADMIN_USER_LOCKED',
      ]);
      expect(trail[2].timestamp.getTime()).toBe((await markOf(id))?.getTime());
    });

    it('(d) same ms: lock, unlock, lock with one injected now => mark +1 ms each step, audits strictly increasing; mark never exposed', async () => {
      const id = await target();
      const svc = full.app.get(UserService);
      const now = new Date(Date.now() + 3_600_000); // fixed, ahead of the clock
      const realLock = svc.adminLock.bind(svc);
      const realUnlock = svc.adminUnlock.bind(svc);
      jest.spyOn(svc, 'adminLock').mockImplementation((sub, level) => realLock(sub, level, now));
      jest.spyOn(svc, 'adminUnlock').mockImplementation((sub, sup) => realUnlock(sub, sup, now));
      const bodies: string[] = [];
      const marks: number[] = [];
      for (const step of [lock, unlock, lock]) {
        const res = await step(id, superAt);
        expect(res.statusCode).toBe(200);
        bodies.push(res.body);
        marks.push((await markOf(id))?.getTime() ?? -1);
      }
      expect(marks).toEqual([now.getTime(), now.getTime() + 1, now.getTime() + 2]);
      const trail = await successTrail(id);
      expect(trail.map((r) => [r.action, r.timestamp.getTime()])).toEqual([
        ['ADMIN_USER_LOCKED', marks[0]],
        ['ADMIN_USER_UNLOCKED', marks[1]],
        ['ADMIN_USER_LOCKED', marks[2]],
      ]);
      // Exposure: the mark never leaves the server (responses, user view, audit metadata, log).
      bodies.push((await api('GET', `/admin/users/${id}`, superAt)).body);
      for (const body of bodies) expect(body).not.toContain('adminLockMarkAt');
      const all = await audits({ targetId: id });
      expect(JSON.stringify(all.map((r) => r.metadata ?? {}))).not.toContain('adminLockMarkAt');
      expect(pino.join('')).not.toContain('adminLockMarkAt');
    });
  });

  // ---------------------------------------------------------------- DEBT-209/156

  describe('DEBT-209/156: disable -> enable kills everything created before', () => {
    const setDisabled = (clientId: string, disabled: boolean) =>
      api('PATCH', `/admin/clients/${clientId}`, superAt, { disabled });
    async function disableEnable(clientId: string) {
      expect((await setDisabled(clientId, true)).statusCode).toBe(200);
      expect((await setDisabled(clientId, false)).statusCode).toBe(200);
    }
    const authorizeUrl = (clientId: string) =>
      `/authorize?response_type=code&client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent(FLOW_REDIRECT)}` +
      `&scope=${encodeURIComponent('openid profile')}&state=victim-state&nonce=rp-nonce` +
      `&code_challenge=${encodeURIComponent('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')}` +
      `&code_challenge_method=S256`;
    async function consentCtx(clientId: string, sessionId: string) {
      const res = await full.app.inject({
        method: 'GET',
        url: authorizeUrl(clientId),
        cookies: { [SESSION_COOKIE]: sessionId },
      });
      expect(res.statusCode).toBe(200);
      return {
        csrf: res.body.match(/name="_csrf" value="([^"]+)"/)![1],
        requestId: res.body.match(/name="request_id" value="([^"]+)"/)![1],
      };
    }
    const decide = (sessionId: string, c: { csrf: string; requestId: string }) =>
      full.app.inject({
        method: 'POST',
        url: '/authorize/consent',
        cookies: { [SESSION_COOKIE]: sessionId },
        payload: { _csrf: c.csrf, request_id: c.requestId, approve: 'true' },
      });
    async function loginCtx(clientId: string) {
      const res = await full.app.inject({ method: 'GET', url: authorizeUrl(clientId) });
      expect(res.statusCode).toBe(302);
      const returnTo = new URL(String(res.headers['location']), FULL_APP_ISSUER).searchParams.get(
        'returnTo',
      )!;
      return new URLSearchParams(returnTo.split('?')[1]).get('request_id')!;
    }
    const resume = (rid: string, sessionId: string) =>
      full.app.inject({
        method: 'GET',
        url: `/authorize?request_id=${encodeURIComponent(rid)}`,
        cookies: { [SESSION_COOKIE]: sessionId },
      });
    function expectFirstParty(res: {
      statusCode: number;
      headers: Record<string, unknown>;
      body: string;
    }) {
      expect(res.statusCode).toBe(400);
      expect(res.headers['location']).toBeUndefined();
      expect(res.body).not.toContain('victim-state');
      expect(res.body).not.toMatch(/[?&]code=/);
    }
    function expectInvalidGrant(res: InjectResponse) {
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_grant');
      expect(res.body).not.toMatch(/access_token|eyJ/);
    }

    /** Every artefact kind for a confidential + a public client of one user. */
    async function artefacts(conf: Auth, pub: string) {
      const user = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
      const tokens = await login(user, conf, FLOW_API_AUD, API_SCOPE);
      const unused = await codeFor(user, conf, FLOW_API_AUD, API_SCOPE);
      const sid = await newSession(user);
      const consent = await consentCtx(pub, sid);
      const rid = await loginCtx(pub);
      return { user, tokens, unused, sid, consent, rid };
    }

    it('D1 disable -> enable (well within 60 s): code, AT, RT, consent ctx, login ctx created before are all dead; never-disabled control client unaffected', async () => {
      const conf = await mkConfidential(['api']);
      const pub = await mkPublic();
      const ctrlConf = await mkConfidential(['api']);
      const ctrlPub = await mkPublic();
      const a = await artefacts(conf, pub);
      const c = await artefacts(ctrlConf, ctrlPub);
      const t0 = Date.now();
      await disableEnable(conf.clientId);
      await disableEnable(pub);
      expect(Date.now() - t0).toBeLessThan(60_000);
      expect(
        (await clientModel.findOne({ clientId: conf.clientId }).lean())?.disabledAt,
      ).toBeNull();

      expectInvalidGrant(await exchange(conf, a.unused));
      expect((await introspect(a.tokens.access_token)).active).toBe(false);
      expect((await userinfo(a.tokens.access_token)).statusCode).toBe(401);
      expectInvalidGrant(
        await formPost(full, '/token', conf, {
          grant_type: 'refresh_token',
          refresh_token: a.tokens.refresh_token,
        }),
      );
      const codesBefore = (await redis.keys('authz_code:*')).length;
      expectFirstParty(await decide(a.sid, a.consent));
      expectFirstParty(await resume(a.rid, a.sid));
      expect((await redis.keys('authz_code:*')).length).toBe(codesBefore);
      expect(
        await auditModel.countDocuments({
          action: 'TOKEN_ISSUED',
          result: 'failure',
          reason: 'client_disabled',
          clientId: conf.clientId,
        }),
      ).toBe(1);

      // control: nothing of a never-disabled client is affected
      expect((await exchange(ctrlConf, c.unused)).statusCode).toBe(200);
      expect((await introspect(c.tokens.access_token)).active).toBe(true);
      expect((await userinfo(c.tokens.access_token)).statusCode).toBe(200);
      expect(
        (
          await formPost(full, '/token', ctrlConf, {
            grant_type: 'refresh_token',
            refresh_token: c.tokens.refresh_token,
          })
        ).statusCode,
      ).toBe(200);
      const d = await decide(c.sid, c.consent);
      expect(d.statusCode).toBe(302);
      expect(String(d.headers['location'])).toMatch(/[?&]code=/);
      // consent was just granted by the approve above => the resumed login ctx mints a code
      expect(String((await resume(c.rid, c.sid)).headers['location'])).toMatch(/[?&]code=/);
    });

    it('D2 artefacts created right after enable (inside the 5 s margin) are refused (by design); after the margin (lastDisabledAt back-dated 10 s) everything lives', async () => {
      const conf = await mkConfidential(['api']);
      const pub = await mkPublic();
      await disableEnable(conf.clientId);
      await disableEnable(pub);
      const user = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
      // inside margin
      expectInvalidGrant(await exchange(conf, await codeFor(user, conf, FLOW_API_AUD, API_SCOPE)));

      const past = new Date(Date.now() - 10_000);
      await clientModel.updateMany(
        { clientId: { $in: [conf.clientId, pub] } },
        { $set: { lastDisabledAt: past } },
      );
      const a = await artefacts(conf, pub);
      expect((await exchange(conf, a.unused)).statusCode).toBe(200);
      expect((await introspect(a.tokens.access_token)).active).toBe(true);
      expect((await userinfo(a.tokens.access_token)).statusCode).toBe(200);
      expect(
        (
          await formPost(full, '/token', conf, {
            grant_type: 'refresh_token',
            refresh_token: a.tokens.refresh_token,
          })
        ).statusCode,
      ).toBe(200);
      const d = await decide(a.sid, a.consent);
      expect(d.statusCode).toBe(302);
      expect(String((await resume(a.rid, a.sid)).headers['location'])).toMatch(/[?&]code=/);
    });
  });

  // ---------------------------------------------------------------- exposure

  it('X1 exposure: no plaintext secret / JWT in the app log or the audit trail', async () => {
    const log = pino.join('');
    expect(log).not.toMatch(JWT);
    for (const s of plaintexts) expect(log).not.toContain(s);
    const auditDump = JSON.stringify(await auditModel.find({}).lean());
    expect(auditDump).not.toMatch(JWT);
    for (const s of plaintexts) expect(auditDump).not.toContain(s);
    expect(plaintexts.length).toBeGreaterThan(0);
  });
});
