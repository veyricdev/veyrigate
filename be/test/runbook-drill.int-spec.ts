import { randomBytes, randomUUID } from 'node:crypto';
import { decodeProtectedHeader } from 'jose';
import { Types, type Model } from 'mongoose';
import { hashPassword, verifyPassword } from '../src/common/crypto/crypto.util';
import { seedBootstrap } from '../src/database/seed';
import { AuthenticationService } from '../src/modules/authentication/authentication.service';
import { ClientCredentialService } from '../src/modules/clients/client-credential.service';
import { ClientService } from '../src/modules/clients/client.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { TokenVerifier } from '../src/modules/keys/token-verifier';
import { SessionService } from '../src/modules/sessions/session.service';
import {
  authorizeCode,
  bootFullApp,
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
 * Run 40 (B7.5) drill of `docs/agile/sso-idp/runbook-ops.md` §1–§3 on the REAL app (`vg-test-*`,
 * throwaway DB `vg-int-runbook-drill-<ts>`, temp `KEY_LOCAL_DIR`). Each `it` walks the runbook steps
 * in order and asserts what the runbook claims, so the runbook cannot go stale silently — in
 * particular the two "surprising" facts it relies on:
 * - `GET /admin/audit?action=TOKEN_REUSE_DETECTED` is EMPTY (the event has no tenantId, DEBT-140);
 * - `db:seed` restores `super_admin` but never resets the password nor clears a lock.
 * The mongosh steps of the runbook are replayed here with the same filter/update documents.
 */
const METRICS_TOKEN = randomBytes(32).toString('hex');
const ADMIN_SCOPE = 'openid admin.read admin.write offline_access';
const RP_SCOPE = 'openid offline_access api.read';
// Test-only values for throwaway int DB users.
const OLD_PASSWORD = 'drill-old-password-1';
const SEED_PASSWORD = 'drill-seed-password-2';

type Auth = { clientId: string; secret: string };
type Tokens = { access_token: string; refresh_token: string };

describe('Runbook drill (run 40 B7.5): runbook-ops §1 key, §2 reuse, §3 admin recovery', () => {
  let full: FullApp;
  let adminClient: Auth;
  let rp: Auth;
  let superId = '';
  let userModel: Model<Record<string, unknown>>;
  let memberModel: Model<Record<string, unknown>>;
  let auditModel: Model<Record<string, unknown>>;
  let rtModel: Model<Record<string, unknown>>;

  beforeAll(async () => {
    full = await bootFullApp({ name: 'runbook-drill', env: { METRICS_TOKEN } });
    userModel = full.conn.model<Record<string, unknown>>('User');
    memberModel = full.conn.model<Record<string, unknown>>('UserTenant');
    auditModel = full.conn.model<Record<string, unknown>>('AuditLog');
    rtModel = full.conn.model<Record<string, unknown>>('RefreshToken');
    adminClient = await seedFlowClient(full); // resources `api` + `admin`, admin-capable BFF
    const rpId = `drill-rp-${randomUUID()}`;
    await full.app.get(ClientService).create({
      clientId: rpId,
      clientType: 'confidential',
      tokenEndpointAuthMethod: 'client_secret_basic',
      redirectUris: [FLOW_REDIRECT],
      allowedResources: ['api'],
      scopes: ['openid', 'offline_access', 'api.read'],
      grantTypes: ['authorization_code', 'refresh_token'],
      tenantId: DEFAULT_TENANT_ID,
    });
    rp = {
      clientId: rpId,
      secret: (await full.app.get(ClientCredentialService).createSecret(rpId)).secret,
    };
    superId = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
    await memberModel.updateOne(
      { userId: new Types.ObjectId(superId), tenantId: DEFAULT_TENANT_ID },
      { $set: { roles: ['super_admin'] } },
    );
  }, 90_000);

  afterAll(async () => {
    if (full) await full.close();
  });

  /** Interactive login (fresh session => fresh `auth_time`) -> code -> `/token`. */
  async function login(
    userId: string,
    client: Auth,
    resource: string,
    scope: string,
    sessionId?: string,
  ): Promise<Tokens> {
    const sid =
      sessionId ?? (await full.app.get(SessionService).create(userId, DEFAULT_TENANT_ID)).id;
    await seedConsent(full.conn, {
      userId,
      clientId: client.clientId,
      resource,
      scopes: scope.split(' '),
    });
    const verifier = randomBytes(32).toString('base64url');
    const code = await authorizeCode(full, {
      ...client,
      sessionId: sid,
      resource,
      scope,
      verifier,
    });
    const res = await formPost(full, '/token', client, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: FLOW_REDIRECT,
      code_verifier: verifier,
    });
    expect(res.statusCode).toBe(200);
    return res.json<Tokens>();
  }
  const adminLogin = (userId = superId) => login(userId, adminClient, FLOW_ADMIN_AUD, ADMIN_SCOPE);
  const rpLogin = (userId: string) => login(userId, rp, FLOW_API_AUD, RP_SCOPE);
  const refresh = (client: Auth, rt: string) =>
    formPost(full, '/token', client, { grant_type: 'refresh_token', refresh_token: rt });
  const admin = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    at: string,
    payload?: unknown,
  ): Promise<InjectResponse> =>
    full.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${at}`,
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });
  const jwksKids = async (): Promise<string[]> =>
    (await full.app.inject({ method: 'GET', url: '/jwks.json' }))
      .json<{ keys: { kid: string }[] }>()
      .keys.map((k) => k.kid);
  const kidOf = (jwt: string) => decodeProtectedHeader(jwt).kid;
  /** Alert input of `SsoTokenReuseDetected` (process-wide registry => compare deltas). */
  const reuseMetric = async (): Promise<number> => {
    const text = (
      await full.app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: `Bearer ${METRICS_TOKEN}` },
      })
    ).body;
    const line = text
      .split('\n')
      .find(
        (l) =>
          l.startsWith('sso_audit_events_total{') &&
          l.includes('action="TOKEN_REUSE_DETECTED"') &&
          l.includes('result="failure"'),
      );
    return line ? Number(line.trim().split(' ').pop()) : 0;
  };

  it('§1 emergency rotation: step-up enforced, old AT 401, JWKS = newKid only, refresh survives, audit visible', async () => {
    const adm = await adminLogin();
    const user = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
    const rpTokens = await rpLogin(user);
    const oldKid = kidOf(adm.access_token);

    // Before: GET /admin/keys shows the active kid (the "check state before any retry" call).
    const before = await admin('GET', '/admin/keys', adm.access_token);
    expect(before.statusCode).toBe(200);
    expect(
      before
        .json<{ items: { kid: string; status: string }[] }>()
        .items.find((k) => k.status === 'active')?.kid,
    ).toBe(oldKid);

    // A refreshed admin AT carries no auth_time => no step-up => refused, nothing rotated.
    const refreshedAdmin = await refresh(adminClient, adm.refresh_token);
    expect(refreshedAdmin.statusCode).toBe(200);
    const noStepUp = await admin(
      'POST',
      '/admin/keys/rotate',
      refreshedAdmin.json<Tokens>().access_token,
      {
        mode: 'emergency',
      },
    );
    expect(noStepUp.statusCode).toBe(403);
    expect(noStepUp.json()).toEqual({ error: 'step_up_required', max_age: 0 });
    expect(await jwksKids()).toEqual([oldKid]);

    // Step: rotate with a fresh-login (auth_time <= 5 min) super_admin token.
    const rotated = await admin('POST', '/admin/keys/rotate', adm.access_token, {
      mode: 'emergency',
    });
    expect(rotated.statusCode).toBe(200);
    const {
      newKid,
      oldKid: reportedOld,
      mode,
    } = rotated.json<{
      newKid: string;
      oldKid: string;
      mode: string;
    }>();
    expect(mode).toBe('emergency');
    expect(reportedOld).toBe(oldKid);
    expect(newKid).not.toBe(oldKid);

    // Verify: JWKS only newKid; every AT signed by the old key fails (admin API 401, verifier throws).
    expect(await jwksKids()).toEqual([newKid]);
    expect((await admin('GET', '/admin/keys', adm.access_token)).statusCode).toBe(401);
    await expect(
      full.app.get(TokenVerifier).verifyAccessToken(rpTokens.access_token),
    ).rejects.toThrow();

    // Sessions/refresh tokens are NOT revoked: refresh mints an AT signed by newKid.
    const rpRefreshed = await refresh(rp, rpTokens.refresh_token);
    expect(rpRefreshed.statusCode).toBe(200);
    const newRpAt = rpRefreshed.json<Tokens>().access_token;
    expect(kidOf(newRpAt)).toBe(newKid);
    await expect(full.app.get(TokenVerifier).verifyAccessToken(newRpAt)).resolves.toBeTruthy();
    const adminAgain = await refresh(adminClient, refreshedAdmin.json<Tokens>().refresh_token);
    expect(adminAgain.statusCode).toBe(200);
    const readAt = adminAgain.json<Tokens>().access_token; // admin.read needs no step-up

    // Verify via API (what the on-call checks before deciding on any retry, DEBT-158).
    const keys = (await admin('GET', '/admin/keys', readAt)).json<{
      items: { kid: string; status: string }[];
    }>().items;
    expect(keys.map((k) => k.kid)).toEqual([newKid]);
    expect(keys[0].status).toBe('active');
    const audit = await admin('GET', '/admin/audit?action=SIGNING_KEY_ROTATED', readAt);
    expect(audit.statusCode).toBe(200);
    const ev = audit.json<{
      items: { targetId: string; result: string; metadata: Record<string, unknown> }[];
    }>().items[0];
    expect(ev).toMatchObject({ targetId: newKid, result: 'success' });
    expect(ev.metadata).toMatchObject({ mode: 'emergency', oldKid });
  }, 60_000);

  it('§2 TOKEN_REUSE_DETECTED: family auto-revoked, admin audit EMPTY, mongosh path finds the user, revoke tools work', async () => {
    const victim = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
    const metricBefore = await reuseMetric();

    const first = await rpLogin(victim);
    const rotated = await refresh(rp, first.refresh_token);
    expect(rotated.statusCode).toBe(200);
    const replay = await refresh(rp, first.refresh_token); // the stolen copy is replayed
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject({ error: 'invalid_grant' });
    // The whole family is already revoked (the legitimate successor dies too).
    expect((await refresh(rp, rotated.json<Tokens>().refresh_token)).statusCode).toBe(400);

    // Signal (a): the metric behind the SsoTokenReuseDetected alert.
    expect((await reuseMetric()) - metricBefore).toBe(1);

    // Admin API audit query is EMPTY for this action (no tenantId on the event, DEBT-140).
    const adm = await adminLogin();
    const viaApi = await admin('GET', '/admin/audit?action=TOKEN_REUSE_DETECTED', adm.access_token);
    expect(viaApi.statusCode).toBe(200);
    expect(viaApi.json<{ items: unknown[] }>().items).toEqual([]);

    // Signal (b): read-only mongosh queries of the runbook (same filters / projections).
    const events = await auditModel
      .find({ action: 'TOKEN_REUSE_DETECTED' })
      .sort({ timestamp: -1 })
      .lean<
        { clientId?: string; tenantId?: string; metadata?: { familyId?: string; count?: number } }[]
      >();
    expect(events).toHaveLength(1);
    expect(events[0].tenantId).toBeUndefined();
    expect(events[0].clientId).toBe(rp.clientId);
    expect(events[0].metadata?.count).toBeGreaterThanOrEqual(1);
    const familyId = String(events[0].metadata?.familyId);
    const owner = await rtModel
      .findOne({ familyId }, { userId: 1, clientId: 1 })
      .lean<{ userId: Types.ObjectId; clientId: string }>();
    expect(owner?.userId.toHexString()).toBe(victim);
    expect(owner?.clientId).toBe(rp.clientId);
    const byClient = await auditModel.aggregate<{ _id: string; n: number }>([
      {
        $match: {
          action: 'TOKEN_REUSE_DETECTED',
          timestamp: { $gte: new Date(Date.now() - 3_600_000) },
        },
      },
      { $group: { _id: '$clientId', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ]);
    expect(byClient).toEqual([{ _id: rp.clientId, n: 1 }]);

    // Action: end every session + family of the user.
    const again = await rpLogin(victim);
    expect(
      (await admin('POST', `/admin/users/${victim}/sessions/revoke`, adm.access_token)).statusCode,
    ).toBe(204);
    expect((await refresh(rp, again.refresh_token)).statusCode).toBe(400);

    // Action: revoke one family (id from GET /admin/users/:id/families).
    const one = await rpLogin(victim);
    const fam = await rtModel
      .findOne({ userId: new Types.ObjectId(victim), revokedAt: null })
      .lean<{ familyId: string }>();
    const listed = (await admin('GET', `/admin/users/${victim}/families`, adm.access_token)).json<{
      items: { familyId: string }[];
    }>().items;
    expect(listed.map((f) => f.familyId)).toContain(fam?.familyId);
    expect(
      (
        await admin(
          'POST',
          `/admin/users/${victim}/families/${fam?.familyId}/revoke`,
          adm.access_token,
        )
      ).statusCode,
    ).toBe(204);
    expect((await refresh(rp, one.refresh_token)).statusCode).toBe(400);

    // Action: compromised client => disable (revokes every RT of the client, DEBT-125).
    const other = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
    const activeBefore = await rtModel.countDocuments({ clientId: rp.clientId, revokedAt: null });
    const live = [await rpLogin(victim), await rpLogin(other)];
    expect(await rtModel.countDocuments({ clientId: rp.clientId, revokedAt: null })).toBe(
      activeBefore + 2,
    );
    const disabled = await admin('PATCH', `/admin/clients/${rp.clientId}`, adm.access_token, {
      disabled: true,
    });
    expect(disabled.statusCode).toBe(200);
    expect(await rtModel.countDocuments({ clientId: rp.clientId, revokedAt: null })).toBe(0);
    // Runbook §2 "Xác minh": a disabled client fails client auth first => 401 invalid_client.
    for (const t of live) {
      const res = await refresh(rp, t.refresh_token);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: 'invalid_client' });
    }
  }, 60_000);

  it('§3 lost admin: seed refuses production, restores super_admin, never resets the password nor the lock; break-glass unlock', async () => {
    // Arrange: 0 super_admin anywhere; the admin to recover is suspended + brute-force locked.
    await memberModel.updateMany({ roles: 'super_admin' }, { $pull: { roles: 'super_admin' } });
    expect(await memberModel.countDocuments({ roles: 'super_admin' })).toBe(0);
    const adm = await adminLogin();
    expect((await admin('GET', '/admin/keys', adm.access_token)).statusCode).toBe(403);

    const email = `drill-admin-${randomUUID()}@fixture.test`;
    const lockedUntil = new Date(Date.now() + 3_600_000);
    const target = await userModel.create({
      email,
      passwordHash: await hashPassword(OLD_PASSWORD),
      emailVerifiedAt: new Date(),
      failedLoginCount: 5,
      lockedUntil,
    });
    const targetId = (target._id as Types.ObjectId).toHexString();
    await memberModel.create({
      userId: target._id,
      tenantId: DEFAULT_TENANT_ID,
      status: 'suspended',
      roles: [],
    });

    // NODE_ENV=production => refused BEFORE any write.
    const ghost = `drill-ghost-${randomUUID()}@fixture.test`;
    await expect(
      seedBootstrap(
        full.conn,
        { email: ghost, password: SEED_PASSWORD },
        FULL_APP_ISSUER,
        'production',
      ),
    ).rejects.toThrow(/refusing to run with NODE_ENV=production/);
    expect(await userModel.exists({ email: ghost })).toBeNull();
    expect(await memberModel.countDocuments({ roles: 'super_admin' })).toBe(0);

    // dev/test: the seed restores the membership + role ...
    await seedBootstrap(full.conn, { email, password: SEED_PASSWORD }, FULL_APP_ISSUER, 'test');
    const member = await memberModel
      .findOne({ userId: target._id, tenantId: DEFAULT_TENANT_ID })
      .lean<{ status: string; roles: string[] }>();
    expect(member?.status).toBe('active');
    expect(member?.roles).toContain('super_admin');
    // ... but never the password nor the lock (`$setOnInsert`).
    const after = await userModel
      .findById(target._id)
      .select('+passwordHash')
      .lean<{ passwordHash: string; lockedUntil?: Date; failedLoginCount: number }>();
    expect(await verifyPassword(after!.passwordHash, OLD_PASSWORD)).toBe(true);
    expect(await verifyPassword(after!.passwordHash, SEED_PASSWORD)).toBe(false);
    expect(after?.lockedUntil?.getTime()).toBe(lockedUntil.getTime());
    expect(after?.failedLoginCount).toBe(5);
    const auth = full.app.get(AuthenticationService);
    await expect(auth.login(email, OLD_PASSWORD, {})).rejects.toThrow();

    // Break-glass unlock (runbook mongosh, no other admin left) => the OLD password logs in.
    const u = await userModel.findOne({ email }, { _id: 1 }).lean();
    expect(u).not.toBeNull();
    const unlocked = await userModel.updateOne(
      { _id: u!._id },
      { $unset: { lockedUntil: 1 }, $set: { failedLoginCount: 0 } },
    );
    expect(unlocked.matchedCount).toBe(1);
    const session = await auth.login(email, OLD_PASSWORD, {});
    const recovered = await login(targetId, adminClient, FLOW_ADMIN_AUD, ADMIN_SCOPE, session.id);
    expect((await admin('GET', '/admin/keys', recovered.access_token)).statusCode).toBe(200);
  }, 60_000);

  it('§4(i) post-restore "revoke every RT" (runbook mongosh): live RTs die as plain invalid_grant, no reuse burst', async () => {
    const user = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
    // A family rotated once before the "backup point": `stale` = revoked + replacedBy, `live` = active.
    const stale = await login(user, adminClient, FLOW_API_AUD, RP_SCOPE);
    const live = await refresh(adminClient, stale.refresh_token);
    expect(live.statusCode).toBe(200);
    const metricBefore = await reuseMetric();
    const reuseBefore = await auditModel.countDocuments({ action: 'TOKEN_REUSE_DETECTED' });

    // Runbook §4 step (same two updates as RefreshTokenService.revokeWhere: stamp first).
    const now = new Date();
    await rtModel.updateMany({ familyRevokedAt: null }, { $set: { familyRevokedAt: now } });
    await rtModel.updateMany({ revokedAt: null }, { $set: { revokedAt: now } });
    expect(await rtModel.countDocuments({ revokedAt: null })).toBe(0);

    // The RT the client really holds => invalid_grant, NOT reuse (no replacedBy).
    const res = await refresh(adminClient, live.json<Tokens>().refresh_token);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_grant' });
    expect(await reuseMetric()).toBe(metricBefore);
    expect(await auditModel.countDocuments({ action: 'TOKEN_REUSE_DETECTED' })).toBe(reuseBefore);

    // Only a value already rotated BEFORE the backup point (a stolen copy) still trips reuse.
    expect((await refresh(adminClient, stale.refresh_token)).statusCode).toBe(400);
    expect((await reuseMetric()) - metricBefore).toBe(1);
  }, 60_000);
});
