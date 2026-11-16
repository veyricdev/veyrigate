import { jest } from '@jest/globals';
import { randomBytes, randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { RedisService } from '../src/database/redis/redis.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { MFA_KEYRING, type MfaKeyring } from '../src/modules/mfa/mfa-crypto';
import { RefreshTokenService } from '../src/modules/oauth/token/refresh-token.service';
import { ALERT_ACTIONS, AuditAction } from '../src/modules/security/audit/audit-action.enum';
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
import { enrollForTest } from './helpers/mfa';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';
import { seedConsent, seedOAuthUser } from './oauth-fixtures';

/**
 * Run 89 T4 AC1–AC4 (D89.16) on the REAL app: `POST /admin/users/:id/mfa/reset` (admin.write +
 * step-up 5'), idempotent 204, revoke-all + mail + alerting audit; IDOR / role / step-up refusals;
 * `AdminUserView.mfa` without any secret.
 */
const ADMIN_SCOPE = 'openid admin.read admin.write';
const SEED = Buffer.from('r89-admin-reset-seed', 'ascii');

describe('run 89 T4: admin MFA reset (real app)', () => {
  let full: FullApp;
  let bff: { clientId: string; secret: string };
  let superId: string;
  let tenantAdminId: string;
  let setup: Promise<void> | undefined;
  const members = () => full.conn.model('UserTenant');

  beforeAll(
    () =>
      (setup = (async () => {
        full = await bootFullApp({ name: 'run89-admin-reset' });
        bff = await seedFlowClient(full);
        superId = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
        tenantAdminId = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
        await members().updateOne(
          { userId: new Types.ObjectId(superId) },
          { $set: { roles: ['super_admin'] } },
        );
        await members().updateOne(
          { userId: new Types.ObjectId(tenantAdminId) },
          { $set: { roles: ['tenant_admin'] } },
        );
      })()),
    INT_SETUP_TIMEOUT_MS,
  );
  afterAll(async () => {
    await settled(setup);
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);
  afterEach(() => jest.restoreAllMocks());

  /** Admin access token through a real session (auth_time = session authTime). */
  const adminToken = async (userId: string, ageMs = 0): Promise<string> => {
    const sid = (
      await full.app
        .get(SessionService)
        .create(userId, DEFAULT_TENANT_ID, { authTime: Date.now() - ageMs })
    ).id;
    await seedConsent(full.conn, {
      userId,
      clientId: bff.clientId,
      resource: FLOW_ADMIN_AUD,
      scopes: ADMIN_SCOPE.split(' '),
    });
    const verifier = randomBytes(32).toString('base64url');
    const code = await authorizeCode(full, {
      clientId: bff.clientId,
      sessionId: sid,
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
  };
  const call = (method: 'GET' | 'POST', url: string, at: string) =>
    full.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${at}` },
    }) as Promise<InjectResponse>;
  const reset = (id: string, at: string) => call('POST', `/admin/users/${id}/mfa/reset`, at);
  /** An enrolled user of `tenantId` with a live session + a refresh family. */
  const target = async (tenantId = DEFAULT_TENANT_ID, enroll = true) => {
    const id = await seedOAuthUser(full.conn, { tenantId });
    if (enroll) {
      await enrollForTest(full.conn, full.app.get<MfaKeyring>(MFA_KEYRING), id, SEED);
    }
    const session = await full.app.get(SessionService).create(id, DEFAULT_TENANT_ID);
    await full.conn.collection('refreshtokens').insertOne({
      tokenHash: `r89r-${randomUUID()}`,
      familyId: `r89r-${randomUUID()}`,
      userId: new Types.ObjectId(id),
      clientId: bff.clientId,
      scope: ['admin.read'],
      resource: FLOW_ADMIN_AUD,
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
      revokedAt: null,
    });
    return { id, session };
  };
  const mfaOf = async (id: string) =>
    (await full.conn.collection('users').findOne({ _id: new Types.ObjectId(id) }))?.mfa;
  const resets = (id: string) =>
    full.conn
      .model('AuditLog')
      .find({ action: 'ADMIN_USER_MFA_RESET', targetId: id })
      .sort({ _id: 1 })
      .lean<Array<Record<string, unknown>>>()
      .exec();
  const emailOf = (id: string) => `oauth-${id}@fixture.test`;
  const redis = () => full.app.get(RedisService).client;

  it('AC1/AC2 super_admin resets an enrolled user => 204, mfa gone, sessions + families revoked, alerting audit {wasEnrolled:true}, mail; again => 204 {wasEnrolled:false}, no mail', async () => {
    const at = await adminToken(superId);
    const t = await target();
    const mailsBefore = full.outbox.length;
    const res = await reset(t.id, at);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(await mfaOf(t.id)).toBeUndefined();
    expect(await redis().exists(`sess:${t.session.session.ref}`)).toBe(0);
    expect(
      await full.conn
        .collection('refreshtokens')
        .countDocuments({ userId: new Types.ObjectId(t.id), revokedAt: null }),
    ).toBe(0);
    const ev = await resets(t.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      result: 'success',
      actorId: superId,
      targetType: 'user',
      metadata: { wasEnrolled: true },
    });
    expect(ALERT_ACTIONS.has(AuditAction.ADMIN_USER_MFA_RESET)).toBe(true);
    const mails = full.outbox.slice(mailsBefore).filter((m) => m.to === emailOf(t.id));
    expect(mails.map((m) => m.subject)).toEqual([
      'Two-step verification was reset by an administrator',
    ]);

    const again = await reset(t.id, at);
    expect(again.statusCode).toBe(204);
    expect((await resets(t.id)).map((e) => e.metadata)).toEqual([
      { wasEnrolled: true },
      { wasEnrolled: false },
    ]);
    expect(full.outbox.slice(mailsBefore).filter((m) => m.to === emailOf(t.id))).toHaveLength(1);
  });

  it('AC3 stale token (> 5 min) => 403 step_up_required, mfa kept', async () => {
    const stale = await adminToken(superId, 10 * 60_000);
    const t = await target();
    const res = await reset(t.id, stale);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'step_up_required' });
    expect(await mfaOf(t.id)).toBeDefined();
  });

  it('AC3 user of another tenant => 404, mfa kept; tenant_admin -> super_admin target => 403 + audit target_super_admin, mfa kept', async () => {
    const at = await adminToken(superId);
    const foreign = await target('tenant-r89-other');
    const res = await reset(foreign.id, at);
    expect(res.statusCode).toBe(404);
    expect(await mfaOf(foreign.id)).toBeDefined();

    const ta = await adminToken(tenantAdminId);
    const victim = await target();
    await members().updateOne(
      { userId: new Types.ObjectId(victim.id) },
      { $set: { roles: ['super_admin'] } },
    );
    const refused = await reset(victim.id, ta);
    expect(refused.statusCode).toBe(403);
    expect(await mfaOf(victim.id)).toBeDefined();
    expect(await resets(victim.id)).toEqual([
      expect.objectContaining({ result: 'failure', reason: 'target_super_admin' }),
    ]);
  });

  it('AC3 a token without admin.write => 403', async () => {
    const at = await adminToken(superId);
    const t = await target();
    // A read-only scope token: same flow, narrower scope.
    const sid = (await full.app.get(SessionService).create(superId, DEFAULT_TENANT_ID)).id;
    const verifier = randomBytes(32).toString('base64url');
    const code = await authorizeCode(full, {
      clientId: bff.clientId,
      sessionId: sid,
      resource: FLOW_ADMIN_AUD,
      scope: 'openid admin.read',
      verifier,
    });
    const ro = (
      await formPost(full, '/token', bff, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: FLOW_REDIRECT,
        code_verifier: verifier,
      })
    ).json<{ access_token: string }>().access_token;
    expect((await reset(t.id, ro)).statusCode).toBe(403);
    expect(await mfaOf(t.id)).toBeDefined();
    expect(at).toBeTruthy();
  });

  it('failure: revoke-all fails after the factor was removed => 5xx + revoke_failed audit, mfa stays removed; a retry finishes (204)', async () => {
    const at = await adminToken(superId);
    const t = await target();
    jest
      .spyOn(full.app.get(RefreshTokenService), 'revokeAllForUser')
      .mockRejectedValueOnce(new Error('mongo down'));
    const mailsBefore = full.outbox.length;
    const res = await reset(t.id, at);
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(await mfaOf(t.id)).toBeUndefined();
    expect((await resets(t.id)).map((e) => e.reason ?? e.result)).toEqual(['revoke_failed']);
    expect((await reset(t.id, at)).statusCode).toBe(204);
    // DEBT-642 (D89.26): the owner is told exactly once, although the retry saw wasEnrolled:false.
    const mails = full.outbox.slice(mailsBefore).filter((m) => m.to === emailOf(t.id));
    expect(mails).toHaveLength(1);
  });

  it('nit 6: tenant_admin -> a plain user also active in another tenant => 403 target_not_allowed, mfa kept', async () => {
    const ta = await adminToken(tenantAdminId);
    const shared = await target();
    await members().create({
      userId: new Types.ObjectId(shared.id),
      tenantId: 'tenant-r89-shared',
      status: 'active',
      roles: [],
    });
    const res = await reset(shared.id, ta);
    expect(res.statusCode).toBe(403);
    expect(await mfaOf(shared.id)).toBeDefined();
    expect(await resets(shared.id)).toEqual([
      expect.objectContaining({ result: 'failure', reason: 'target_not_allowed' }),
    ]);
  });

  it('AC4 GET user / list => mfa {enrolled, enrolledAt}; never secret, recovery or salt', async () => {
    const at = await adminToken(superId);
    const t = await target();
    const plain = await target(DEFAULT_TENANT_ID, false);
    const one = await call('GET', `/admin/users/${t.id}`, at);
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ mfa: { enrolled: true, enrolledAt: expect.any(String) } });
    expect((await call('GET', `/admin/users/${plain.id}`, at)).json()).toMatchObject({
      mfa: { enrolled: false, enrolledAt: null },
    });
    const list = await call('GET', '/admin/users?limit=100', at);
    const row = list
      .json<{ items: { id: string; mfa: unknown }[] }>()
      .items.find((u) => u.id === t.id);
    expect(row?.mfa).toMatchObject({ enrolled: true });
    for (const body of [one.body, list.body]) {
      expect(body).not.toMatch(/"secret"|recovery|recoverySalt|"ct"|failures/);
    }
  });
});
