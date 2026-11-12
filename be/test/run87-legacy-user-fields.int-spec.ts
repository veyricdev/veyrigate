import { Types } from 'mongoose';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../src/common/crypto/crypto.util';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { ADMIN_LOCKED_UNTIL, UserService } from '../src/modules/identity/user.service';
import { AuditAction } from '../src/modules/security/audit/audit-action.enum';
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
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';
import { seedConsent, seedOAuthUser } from './oauth-fixtures';

/**
 * Run 87 T4 (DEBT-589, D87.17): `failedLoginCount` and `lockTransitionNonce` are gone from the
 * schema and from every write. A document that still carries them (written before the deploy,
 * cleaned later by runbook-deploy §15) keeps them untouched by login success / reset / admin
 * unlock; the unlock audit depends on `lockedUntil` only; the admin view never shows them.
 */
const SCOPE = 'openid admin.read admin.write offline_access';
const LEGACY = { failedLoginCount: 3, lockTransitionNonce: 'r87-legacy-nonce' };

describe('run 87 T4: legacy user fields failedLoginCount / lockTransitionNonce (real app)', () => {
  let full: FullApp;
  let client: { clientId: string; secret: string };
  let adminId = '';

  const boot = async (): Promise<void> => {
    full = await bootFullApp({ name: 'run87-legacy' });
    client = await seedFlowClient(full);
    adminId = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
    await full.conn
      .model('UserTenant')
      .updateOne(
        { userId: new Types.ObjectId(adminId), tenantId: DEFAULT_TENANT_ID },
        { $set: { roles: ['super_admin'] } },
      );
    await seedConsent(full.conn, {
      userId: adminId,
      clientId: client.clientId,
      resource: FLOW_ADMIN_AUD,
      scopes: SCOPE.split(' '),
    });
  };
  let setup: Promise<void> | undefined;
  beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await settled(setup);
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);

  const users = () => full.conn.collection('users');

  /** A raw legacy document (bypasses the schema) + an active membership in the default tenant. */
  const legacyUser = async (extra: Record<string, unknown> = {}): Promise<string> => {
    const _id = new Types.ObjectId();
    const now = new Date();
    await users().insertOne({
      _id,
      email: `r87-${_id.toHexString()}@fixture.test`,
      passwordHash: await hashPassword(randomBytes(12).toString('hex')),
      profile: {},
      emailVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
      ...LEGACY,
      ...extra,
    });
    await full.conn
      .model('UserTenant')
      .create({ userId: _id, tenantId: DEFAULT_TENANT_ID, status: 'active' });
    return _id.toHexString();
  };
  const raw = (id: string) => users().findOne({ _id: new Types.ObjectId(id) });

  const adminToken = async (): Promise<string> => {
    const { id } = await full.app.get(SessionService).create(adminId, DEFAULT_TENANT_ID);
    const verifier = randomBytes(32).toString('base64url');
    const code = await authorizeCode(full, {
      ...client,
      sessionId: id,
      resource: FLOW_ADMIN_AUD,
      scope: SCOPE,
      verifier,
    });
    const res = await formPost(full, '/token', client, {
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
  const unlockAudits = (id: string) =>
    full.conn
      .model('AuditLog')
      .countDocuments({ action: AuditAction.ADMIN_USER_UNLOCKED, targetId: id });

  it('AC2 login success (clearFailedLoginsIfUnlocked) never writes failedLoginCount', async () => {
    const id = await legacyUser({ lockedUntil: new Date(Date.now() - 1000) });
    expect(await full.app.get(UserService).clearFailedLoginsIfUnlocked(id)).not.toBeNull();
    const doc = await raw(id);
    expect(doc?.lockedUntil).toBeUndefined(); // expired lock still cleared
    expect(doc).toMatchObject(LEGACY);
  });

  it('AC2 reset (setPassword) never writes failedLoginCount; admin lock kept', async () => {
    const id = await legacyUser({ lockedUntil: ADMIN_LOCKED_UNTIL });
    expect(await full.app.get(UserService).setPassword(id, '$argon2id$fake')).not.toBeNull();
    const doc = await raw(id);
    expect(doc?.lockedUntil?.getTime()).toBe(ADMIN_LOCKED_UNTIL.getTime());
    expect(doc).toMatchObject(LEGACY);
  });

  it('AC3 unlock of a NOT locked user with failedLoginCount > 0 => 200, no audit, field untouched', async () => {
    const id = await legacyUser();
    const res = await call('POST', `/admin/users/${id}/unlock`, await adminToken());
    expect(res.statusCode).toBe(200);
    expect(await unlockAudits(id)).toBe(0);
    expect(await raw(id)).toMatchObject(LEGACY);
  });

  it('AC3 unlock of a locked user => exactly 1 audit, lock gone, legacy field untouched', async () => {
    const id = await legacyUser({ lockedUntil: ADMIN_LOCKED_UNTIL, adminLockLevel: 'super_admin' });
    const res = await call('POST', `/admin/users/${id}/unlock`, await adminToken());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ locked: false, lockedUntil: null });
    expect(await unlockAudits(id)).toBe(1);
    const doc = await raw(id);
    expect(doc?.lockedUntil).toBeUndefined();
    expect(doc).toMatchObject(LEGACY);
  });

  it('AC4 GET /admin/users/:id never carries the legacy keys', async () => {
    const id = await legacyUser();
    const res = await call('GET', `/admin/users/${id}`, await adminToken());
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/failedLoginCount|lockTransitionNonce|r87-legacy-nonce/);
  });
});
