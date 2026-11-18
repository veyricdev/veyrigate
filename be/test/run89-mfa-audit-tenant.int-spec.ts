import { randomBytes, randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { UserService } from '../src/modules/identity/user.service';
import { MFA_KEYRING, type MfaKeyring } from '../src/modules/mfa/mfa-crypto';
import { MFA_FAILURE_CAP } from '../src/modules/mfa/mfa.service';
import { totpAt, totpStep } from '../src/modules/mfa/totp';
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
 * Run 89 DEBT-645 (D89.29) on the REAL app: every MFA audit carries the tenant of its flow, so the
 * tenant's admin sees it in `GET /admin/audit?action=…` (the alerting ones above all).
 */
const PASSWORD = 'r89t-Current#Pass-1';
const SEED = Buffer.from('r89-audit-tenant-sd', 'ascii');

const setCookies = (res: InjectResponse): string[] =>
  ([] as string[]).concat((res.headers['set-cookie'] as string | string[] | undefined) ?? []);
const pairOf = (res: InjectResponse, name: string) =>
  setCookies(res)
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0];
const csrfOf = (res: InjectResponse): string => res.body.match(/name="_csrf" value="([^"]+)"/)![1];
const code = (offset = 0) => totpAt(SEED, totpStep(Date.now()) + offset);

describe('run 89 DEBT-645: MFA audits are visible to the tenant admin (real app)', () => {
  let full: FullApp;
  let adminAt: string;
  let setup: Promise<void> | undefined;
  beforeAll(
    () =>
      (setup = (async () => {
        full = await bootFullApp({ name: 'run89-audit-tenant' });
        const bff = await seedFlowClient(full);
        const superId = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
        await full.conn
          .model('UserTenant')
          .updateOne({ userId: new Types.ObjectId(superId) }, { $set: { roles: ['super_admin'] } });
        const scope = 'openid admin.read';
        await seedConsent(full.conn, {
          userId: superId,
          clientId: bff.clientId,
          resource: FLOW_ADMIN_AUD,
          scopes: scope.split(' '),
        });
        const sid = (await full.app.get(SessionService).create(superId, DEFAULT_TENANT_ID)).id;
        const verifier = randomBytes(32).toString('base64url');
        const c = await authorizeCode(full, {
          clientId: bff.clientId,
          sessionId: sid,
          resource: FLOW_ADMIN_AUD,
          scope,
          verifier,
        });
        adminAt = (
          await formPost(full, '/token', bff, {
            grant_type: 'authorization_code',
            code: c,
            redirect_uri: FLOW_REDIRECT,
            code_verifier: verifier,
          })
        ).json<{ access_token: string }>().access_token;
      })()),
    INT_SETUP_TIMEOUT_MS,
  );
  afterAll(async () => {
    await settled(setup);
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);

  const newUser = async (enroll = true) => {
    const email = `r89t-${randomUUID()}@fixture.test`;
    const users = full.app.get(UserService);
    const u = await users.create({ email, password: PASSWORD });
    await users.verifyEmail(u.sub);
    await full.conn
      .model('UserTenant')
      .create({ userId: new Types.ObjectId(u.sub), tenantId: DEFAULT_TENANT_ID, status: 'active' });
    const enrolled = enroll
      ? await enrollForTest(full.conn, full.app.get<MfaKeyring>(MFA_KEYRING), u.sub, SEED)
      : undefined;
    return { email, sub: u.sub, codes: enrolled?.codes ?? [] };
  };
  const ip = () => `198.19.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const signIn = async (email: string, value: string) => {
    const from = ip();
    const page = (await full.app.inject({
      method: 'GET',
      url: '/login',
      remoteAddress: from,
    })) as InjectResponse;
    const s1 = (await full.app.inject({
      method: 'POST',
      url: '/login',
      remoteAddress: from,
      headers: { cookie: pairOf(page, 'idp_csrf')! },
      payload: { _csrf: csrfOf(page), email, password: PASSWORD },
    })) as InjectResponse;
    const ticket = pairOf(s1, 'idp_mfa');
    if (!ticket) return s1;
    const form = (await full.app.inject({
      method: 'GET',
      url: '/login/mfa',
      headers: { cookie: ticket },
    })) as InjectResponse;
    return full.app.inject({
      method: 'POST',
      url: '/login/mfa',
      remoteAddress: from,
      headers: { cookie: ticket },
      payload: { _csrf: csrfOf(form), code: value },
    }) as Promise<InjectResponse>;
  };
  const accountPost = async (jar: string, path: string, fields: Record<string, string>) => {
    const page = (await full.app.inject({
      method: 'GET',
      url: '/account/mfa',
      headers: { cookie: jar },
    })) as InjectResponse;
    return full.app.inject({
      method: 'POST',
      url: path,
      headers: { cookie: jar },
      payload: { _csrf: csrfOf(page), ...fields },
    }) as Promise<InjectResponse>;
  };
  const seen = async (action: string, userId: string) => {
    const res = await full.app.inject({
      method: 'GET',
      url: `/admin/audit?action=${action}&limit=100`,
      headers: { authorization: `Bearer ${adminAt}` },
    });
    expect(res.statusCode).toBe(200);
    return res
      .json<{ items: { actorId?: string; targetId?: string }[] }>()
      .items.filter((e) => e.actorId === userId || e.targetId === userId).length;
  };

  it('step 2 at /login: AUTH_MFA_FAILED, AUTH_MFA_LOCKED, AUTH_MFA_THROTTLED, MFA_RECOVERY_USED, AUTH_LOGIN_SUCCESS', async () => {
    const u = await newUser();
    await full.conn
      .collection('users')
      .updateOne(
        { _id: new Types.ObjectId(u.sub) },
        { $set: { 'mfa.failures': MFA_FAILURE_CAP - 1 } },
      );
    await signIn(u.email, '000000');
    expect(await seen('AUTH_MFA_FAILED', u.sub)).toBe(1);
    expect(await seen('AUTH_MFA_LOCKED', u.sub)).toBe(1);
    expect((await signIn(u.email, u.codes[0])).statusCode).toBe(303);
    expect(await seen('MFA_RECOVERY_USED', u.sub)).toBe(1);
    expect(await seen('AUTH_LOGIN_SUCCESS', u.sub)).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 11; i++) await signIn(u.email, 'AAAA-BBBB-CCCC-DDDD');
    expect(await seen('AUTH_MFA_THROTTLED', u.sub)).toBe(1);
  });

  it('/account/mfa: MFA_ENROLLED, AUTH_REAUTH_FAILED, MFA_RECOVERY_REGENERATED, MFA_DISABLED', async () => {
    const u = await newUser(false);
    const jar = pairOf(await signIn(u.email, ''), 'idp_session')!;
    const setup = await accountPost(jar, '/account/mfa/start', {});
    const key = setup.body.match(/<code>([A-Z2-7 ]+)<\/code>/)![1].replace(/ /g, '');
    const { base32Decode } = await import('../src/modules/mfa/base32');
    const seed = base32Decode(key);
    await accountPost(jar, '/account/mfa/confirm', {
      code: totpAt(seed, totpStep(Date.now()) - 1),
    });
    expect(await seen('MFA_ENROLLED', u.sub)).toBe(1);

    const b = pairOf(await signIn(u.email, totpAt(seed, totpStep(Date.now()))), 'idp_session')!;
    await accountPost(b, '/account/mfa/disable', {
      current_password: 'wrong-pass-1',
      code: '000000',
    });
    expect(await seen('AUTH_REAUTH_FAILED', u.sub)).toBe(1);
    const regen = await accountPost(b, '/account/mfa/recovery', {
      current_password: PASSWORD,
      code: totpAt(seed, totpStep(Date.now()) + 1),
    });
    expect(await seen('MFA_RECOVERY_REGENERATED', u.sub)).toBe(1);
    const fresh = [...regen.body.matchAll(/<code>([0-9A-Z]{4}(?:-[0-9A-Z]{4}){3})<\/code>/g)].map(
      (m) => m[1],
    );
    const off = await accountPost(b, '/account/mfa/disable', {
      current_password: PASSWORD,
      code: fresh[0],
    });
    expect(off.statusCode).toBe(200);
    expect(await seen('MFA_DISABLED', u.sub)).toBe(1);
    expect(code()).toMatch(/^\d{6}$/);
  });
});
