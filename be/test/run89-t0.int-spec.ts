import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { sha256 } from '../src/common/crypto/crypto.util';
import { RedisService } from '../src/database/redis/redis.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { UserService } from '../src/modules/identity/user.service';
import { AuditAction } from '../src/modules/security/audit/audit-action.enum';
import { SessionService } from '../src/modules/sessions/session.service';
import { bootFullApp, type FullApp, type InjectResponse } from './full-app';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';

/**
 * Run 89 T0 on the REAL app: DEBT-629 (a throttled re-authentication is audited once per window)
 * and DEBT-631 (`/account/sessions/revoke` always tombstones the target it proved was owned).
 */
const PASSWORD = 'r89t0-Current#Pass-1';
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0';

const setCookies = (res: InjectResponse): string[] =>
  ([] as string[]).concat((res.headers['set-cookie'] as string | string[] | undefined) ?? []);
const pairOf = (res: InjectResponse, name: string) =>
  setCookies(res)
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0];
const csrfOf = (res: InjectResponse): string => res.body.match(/name="_csrf" value="([^"]+)"/)![1];

describe('run 89 T0: DEBT-629 / DEBT-631 (real app)', () => {
  let full: FullApp;
  let redis: RedisService['client'];
  let sessions: SessionService;
  let setup: Promise<void> | undefined;
  beforeAll(
    () =>
      (setup = (async () => {
        full = await bootFullApp({ name: 'run89-t0' });
        redis = full.app.get(RedisService).client;
        sessions = full.app.get(SessionService);
      })()),
    INT_SETUP_TIMEOUT_MS,
  );
  afterAll(async () => {
    await settled(setup);
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);
  afterEach(() => jest.restoreAllMocks());

  const newUser = async () => {
    const email = `r89t0-${randomUUID()}@fixture.test`;
    const users = full.app.get(UserService);
    const u = await users.create({ email, password: PASSWORD });
    await users.verifyEmail(u.sub);
    await full.conn
      .model('UserTenant')
      .create({ userId: new Types.ObjectId(u.sub), tenantId: DEFAULT_TENANT_ID, status: 'active' });
    return { email, sub: u.sub };
  };
  const ip = () => `198.51.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const login = async (email: string) => {
    const from = ip();
    const page = (await full.app.inject({
      method: 'GET',
      url: '/login',
      remoteAddress: from,
      headers: { 'user-agent': UA },
    })) as InjectResponse;
    const res = (await full.app.inject({
      method: 'POST',
      url: '/login',
      remoteAddress: from,
      headers: { cookie: pairOf(page, 'idp_csrf')!, 'user-agent': UA },
      payload: { _csrf: csrfOf(page), email, password: PASSWORD, returnTo: '/' },
    })) as InjectResponse;
    const session = pairOf(res, 'idp_session')!;
    const id = session.split('=')[1];
    return { id, ref: sha256(id), jar: session };
  };
  const post = async (b: { jar: string }, path: string, fields: Record<string, string>) => {
    const form = (await full.app.inject({
      method: 'GET',
      url: '/account/sessions',
      headers: { cookie: b.jar, 'user-agent': UA },
    })) as InjectResponse;
    return full.app.inject({
      method: 'POST',
      url: path,
      headers: { cookie: b.jar, 'user-agent': UA },
      payload: { _csrf: csrfOf(form), ...fields },
    }) as Promise<InjectResponse>;
  };
  const age = async (ref: string) => {
    const data = JSON.parse((await redis.get(`sess:${ref}`))!) as { authTime: number };
    data.authTime -= 301_000;
    await redis.set(`sess:${ref}`, JSON.stringify(data), 'KEEPTTL');
  };
  const audits = (sub: string, action: AuditAction) =>
    full.conn
      .model('AuditLog')
      .find({ action, actorId: sub })
      .sort({ _id: 1 })
      .lean<Array<Record<string, unknown>>>()
      .exec();

  it('DEBT-629 7 wrong passwords on /account/sessions/revoke => 5x 400, then 429 twice, exactly 1 reauth_throttled audit', async () => {
    const u = await newUser();
    const a = await login(u.email);
    const b = await login(u.email);
    await age(a.ref);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await post(a, '/account/sessions/revoke', {
        ref: b.ref,
        current_password: 'wrong-password-1',
      });
      statuses.push(res.statusCode);
    }
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429, 429]);
    expect(await redis.exists(`sess:${b.ref}`)).toBe(1);
    const failures = (await audits(u.sub, AuditAction.SESSION_REVOKED)).filter(
      (e) => e.result === 'failure',
    );
    expect(failures.filter((e) => e.reason === 'reauth_failed')).toHaveLength(5);
    const throttled = failures.filter((e) => e.reason === 'reauth_throttled');
    expect(throttled).toHaveLength(1);
    expect(throttled[0]).toMatchObject({
      metadata: { scope: 'session', via: 'self' },
      requestId: expect.any(String),
    });
  });

  it('DEBT-629 device scope => the throttled audit uses TRUSTED_DEVICE_REVOKED', async () => {
    const u = await newUser();
    const a = await login(u.email);
    await age(a.ref);
    for (let i = 0; i < 6; i++) {
      await post(a, '/account/devices/forget', {
        device: 'a'.repeat(64),
        current_password: 'wrong-password-1',
      });
    }
    const throttled = (await audits(u.sub, AuditAction.TRUSTED_DEVICE_REVOKED)).filter(
      (e) => e.reason === 'reauth_throttled',
    );
    expect(throttled).toHaveLength(1);
    expect(throttled[0]).toMatchObject({ result: 'failure', metadata: { scope: 'device' } });
  });

  it('DEBT-631 the target vanishes between findOwned and the delete => tombstone still written, 303', async () => {
    const u = await newUser();
    const a = await login(u.email);
    const b = await login(u.email);
    const findOwned = sessions.findOwned.bind(sessions);
    jest.spyOn(sessions, 'findOwned').mockImplementation(async (userId, ref) => {
      const found = await findOwned(userId, ref);
      await redis.del(`sess:${ref}`); // natural expiry / a racing logout in between
      return found;
    });
    const res = await post(a, '/account/sessions/revoke', { ref: b.ref });
    expect(res.statusCode).toBe(303);
    expect(res.headers['location']).toBe('/account/sessions?done=session');
    expect(await redis.exists(`sess_end:${b.ref}`)).toBe(1);
    expect(await redis.sismember(`user_sess:${u.sub}`, b.ref)).toBe(0);
    expect(await redis.exists(`sess:${a.ref}`)).toBe(1);
  });
});
