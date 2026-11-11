import { jest } from '@jest/globals';
import IORedis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { sha256 } from '../src/common/crypto/crypto.util';
import { AuthenticationService } from '../src/modules/authentication/authentication.service';
import { UserService } from '../src/modules/identity/user.service';
import { AuditAction } from '../src/modules/security/audit/audit-action.enum';
import { RateLimitService } from '../src/modules/security/rate-limit/rate-limit.service';
import { RedisService } from '../src/database/redis/redis.service';
import { bootFullApp, type FullApp, type InjectResponse } from './full-app';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';

/**
 * Run 85 T4 (DEBT-575, closes DEBT-016; contract D85.2) on the REAL app over HTTP: the login form
 * is throttled per (email, network) [5/15'], per email for untrusted devices [20/15'] and per
 * (email, trusted device cookie) [10/15'], reserved atomically BEFORE Argon2; there is no hard
 * account lock any more, so no request sequence without the victim's device cookie can lock the
 * victim out of a known device. Redis down => fail-closed (no Argon2, no session).
 */
const PASSWORD = 'r85-correct-password-1';
const WRONG = 'r85-wrong-password-99';
const THROTTLED_TEXT = 'Too many sign-in attempts. Try again later or reset your password.';

type Res = InjectResponse & { cookies: Array<{ name: string; value: string }> };

const setCookies = (res: InjectResponse): string[] =>
  ([] as string[]).concat((res.headers['set-cookie'] as string | string[] | undefined) ?? []);
const csrfOf = (res: InjectResponse): string => res.body.match(/name="_csrf" value="([^"]+)"/)![1];

/** Spy counting Argon2 verifications of the login path (the only caller of `passwordMatches`). */
const argon2Spy = () =>
  jest.spyOn(
    AuthenticationService.prototype as unknown as {
      passwordMatches(hash: string, password: string): Promise<boolean>;
    },
    'passwordMatches',
  );

function suite(secure: boolean) {
  let full: FullApp;
  let redis: IORedis;
  const csrfName = secure ? '__Host-idp_csrf' : 'idp_csrf';
  const sessionName = secure ? '__Host-idp_session' : 'idp_session';
  const dcName = secure ? '__Host-idp_dc' : 'idp_dc';

  const boot = async (): Promise<void> => {
    full = await bootFullApp({
      name: secure ? 'run85-lockout-s' : 'run85-lockout',
      env: { SESSION_COOKIE_SECURE: secure ? 'true' : 'false' },
    });
    redis = new IORedis(full.env.REDIS_URL, { maxRetriesPerRequest: 1 });
  };
  let setup: Promise<void> | undefined;
  beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await settled(setup);
    redis?.disconnect();
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);
  afterEach(() => jest.restoreAllMocks());

  const newUser = async (): Promise<{ email: string; sub: string }> => {
    const email = `r85-${randomUUID()}@fixture.test`;
    const users = full.app.get(UserService);
    const u = await users.create({ email, password: PASSWORD });
    await users.verifyEmail(u.sub);
    return { email, sub: u.sub };
  };

  /** GET /login then POST /login from `ip`, with an optional device cookie (raw value). */
  const login = async (
    email: string,
    password: string,
    ip: string,
    device?: string,
  ): Promise<Res> => {
    const page = (await full.app.inject({
      method: 'GET',
      url: '/login',
      remoteAddress: ip,
    })) as unknown as Res;
    const anon = setCookies(page)
      .find((c) => c.startsWith(`${csrfName}=`))!
      .split(';')[0];
    return (await full.app.inject({
      method: 'POST',
      url: '/login',
      remoteAddress: ip,
      headers: { cookie: [anon, ...(device ? [`${dcName}=${device}`] : [])].join('; ') },
      payload: { _csrf: csrfOf(page), email, password, returnTo: '/' },
    })) as unknown as Res;
  };
  const sessionOf = (res: InjectResponse) =>
    setCookies(res).find((c) => c.startsWith(`${sessionName}=`));
  const deviceOf = (res: InjectResponse) => {
    const c = setCookies(res).find((x) => x.startsWith(`${dcName}=`));
    return c ? c.split(';')[0].split('=')[1] : undefined;
  };
  const expectThrottled = (res: InjectResponse) => {
    expect(res.statusCode).toBe(429);
    expect(res.body).toContain(THROTTLED_TEXT);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(sessionOf(res)).toBeUndefined();
  };
  const expectSignedIn = (res: InjectResponse) => {
    expect(res.statusCode).toBe(302);
    expect(sessionOf(res)).toBeDefined();
  };
  const audits = (action: AuditAction, targetId?: string) =>
    full.conn
      .model('AuditLog')
      .find({ action, ...(targetId ? { targetId } : {}) })
      .lean<Array<Record<string, unknown>>>()
      .exec();

  return {
    get full() {
      return full;
    },
    get redis() {
      return redis;
    },
    newUser,
    login,
    sessionOf,
    deviceOf,
    expectThrottled,
    expectSignedIn,
    audits,
    dcName,
  };
}

describe('run 85 T4: anti-lockout login throttle (real app, http)', () => {
  const s = suite(false);

  it('(1) 5 failures from IP A: the 6th from A is 429 without Argon2; the victim signs in from IP B', async () => {
    const victim = await s.newUser();
    for (let i = 0; i < 5; i++) {
      expect((await s.login(victim.email, WRONG, '198.51.100.1')).statusCode).toBe(401);
    }
    const spy = argon2Spy();
    s.expectThrottled(await s.login(victim.email, WRONG, '198.51.100.1'));
    s.expectThrottled(await s.login(victim.email, PASSWORD, '198.51.100.1'));
    expect(spy).not.toHaveBeenCalled();
    s.expectSignedIn(await s.login(victim.email, PASSWORD, '198.51.100.2'));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('(2) 20 failures over 5 IPs: the 21st from a new IP is 429; the victim with a trusted device signs in', async () => {
    const victim = await s.newUser();
    const first = await s.login(victim.email, PASSWORD, '198.51.100.10');
    s.expectSignedIn(first);
    const device = s.deviceOf(first)!;
    expect(device).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (let i = 0; i < 20; i++) {
      expect((await s.login(victim.email, WRONG, `192.0.2.${10 + (i % 5)}`)).statusCode).toBe(401);
    }
    s.expectThrottled(await s.login(victim.email, WRONG, '192.0.2.99'));
    s.expectThrottled(await s.login(victim.email, PASSWORD, '192.0.2.99'));
    // Also from an IP that has its own network bucket exhausted: the trusted device is not charged.
    const trusted = await s.login(victim.email, PASSWORD, '192.0.2.10', device);
    s.expectSignedIn(trusted);
    // DEBT-596 (D85.11): every successful login rotates the device token; the old one stops being
    // trusted (same exhausted account bucket => 429 with it), the new one is trusted.
    const rotated = s.deviceOf(trusted)!;
    expect(rotated).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rotated).not.toBe(device);
    s.expectThrottled(await s.login(victim.email, PASSWORD, '192.0.2.98', device));
    s.expectSignedIn(await s.login(victim.email, PASSWORD, '192.0.2.98', rotated));
  });

  it('(3) the trusted cookie of user X does not make user Y trusted; a forged cookie is untrusted', async () => {
    const x = await s.newUser();
    const y = await s.newUser();
    const xDevice = s.deviceOf(await s.login(x.email, PASSWORD, '198.51.100.30'))!;
    for (let i = 0; i < 20; i++) await s.login(y.email, WRONG, `203.0.113.${30 + (i % 5)}`);
    s.expectThrottled(await s.login(y.email, PASSWORD, '203.0.113.99', xDevice));
    const forged = 'A'.repeat(43);
    s.expectThrottled(await s.login(y.email, PASSWORD, '203.0.113.99', forged));
    // A device that never logged in for Y stays untrusted even after X logs in again with it.
    s.expectSignedIn(await s.login(x.email, PASSWORD, '203.0.113.99', xDevice));
    s.expectThrottled(await s.login(y.email, PASSWORD, '203.0.113.98', xDevice));
  });

  it('(4) unknown email: 429 at the 6th attempt, body and headers identical to an existing account', async () => {
    const existing = await s.newUser();
    const ghost = `r85-ghost-${randomUUID()}@fixture.test`;
    for (let i = 0; i < 5; i++) {
      expect((await s.login(existing.email, WRONG, '198.51.100.40')).statusCode).toBe(401);
      expect((await s.login(ghost, WRONG, '198.51.100.41')).statusCode).toBe(401);
    }
    const a = await s.login(existing.email, WRONG, '198.51.100.40');
    const b = await s.login(ghost, WRONG, '198.51.100.41');
    s.expectThrottled(a);
    s.expectThrottled(b);
    expect(b.body).toBe(a.body);
    const shape = (r: InjectResponse) =>
      Object.keys(r.headers)
        .filter((h) => h !== 'date' && h !== 'x-request-id')
        .sort();
    expect(shape(b)).toEqual(shape(a));
    expect(
      Math.abs(Number(a.headers['retry-after']) - Number(b.headers['retry-after'])),
    ).toBeLessThanOrEqual(1);
    expect(b.headers['content-length']).toBe(a.headers['content-length']);
  });

  it('(5) 10 concurrent failures for one (email, IP): exactly 5 Argon2, 5 x 429, 1 throttle audit', async () => {
    const victim = await s.newUser();
    const spy = argon2Spy();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => s.login(victim.email, WRONG, '198.51.100.50')),
    );
    expect(spy).toHaveBeenCalledTimes(5);
    expect(results.filter((r) => r.statusCode === 401)).toHaveLength(5);
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(5);
    // Throttled audit: once per bucket per window, scope `network`; no email in it.
    const throttled = await s.audits(AuditAction.AUTH_LOGIN_THROTTLED, victim.sub);
    expect(throttled).toHaveLength(1);
    expect(throttled[0]).toMatchObject({ result: 'failure', metadata: { scope: 'network' } });
    expect(JSON.stringify(throttled[0])).not.toContain(victim.email);
    s.expectThrottled(await s.login(victim.email, WRONG, '198.51.100.50'));
    expect(await s.audits(AuditAction.AUTH_LOGIN_THROTTLED, victim.sub)).toHaveLength(1);
  });

  it('(6) 4 failures + 1 success reset the (email, network) bucket', async () => {
    const victim = await s.newUser();
    for (let i = 0; i < 4; i++) await s.login(victim.email, WRONG, '198.51.100.60');
    s.expectSignedIn(await s.login(victim.email, PASSWORD, '198.51.100.60'));
    for (let i = 0; i < 5; i++) {
      expect((await s.login(victim.email, WRONG, '198.51.100.60')).statusCode).toBe(401);
    }
    s.expectThrottled(await s.login(victim.email, WRONG, '198.51.100.60'));
  });

  it('(7) a successful reset ends device trust and clears the account bucket', async () => {
    const victim = await s.newUser();
    const device = s.deviceOf(await s.login(victim.email, PASSWORD, '198.51.100.70'))!;
    for (let i = 0; i < 20; i++) await s.login(victim.email, WRONG, `198.18.0.${i % 5}`);
    s.expectThrottled(await s.login(victim.email, WRONG, '198.18.0.99'));

    await s.full.app.get(AuthenticationService).forgotPassword(victim.email);
    await new Promise((resolve) => setImmediate(resolve));
    const mail = s.full.outbox.filter((m) => m.to === victim.email).at(-1)!;
    const token = new URL(mail.text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
    const NEW = 'r85-new-password-after-reset';
    await s.full.app.get(AuthenticationService).resetPassword(token, NEW);

    expect(await s.redis.exists(`dc:{u:${sha256(victim.sub)}}`)).toBe(0);
    expect(await s.redis.exists(`lt:{e:${sha256(victim.email)}}:a`)).toBe(0);
    // Account bucket cleared: a new IP gets in with the new password, untrusted.
    s.expectSignedIn(await s.login(victim.email, NEW, '198.18.0.100'));
    // The old device cookie no longer bypasses the network bucket of an exhausted network.
    for (let i = 0; i < 5; i++) await s.login(victim.email, WRONG, '198.18.1.1');
    s.expectThrottled(await s.login(victim.email, NEW, '198.18.1.1', device));
  });

  it('(8) Redis down at reserve: 5xx, no Argon2, no session cookie (fail-closed)', async () => {
    const victim = await s.newUser();
    const spy = argon2Spy();
    jest
      .spyOn(s.full.app.get(RateLimitService), 'reserve')
      .mockRejectedValue(new Error('redis down'));
    const res = await s.login(victim.email, PASSWORD, '198.51.100.80');
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(spy).not.toHaveBeenCalled();
    expect(s.sessionOf(res)).toBeUndefined();
  });

  it('(8b) Redis down at the trusted-device lookup: 5xx, no Argon2, no session cookie', async () => {
    const victim = await s.newUser();
    const device = s.deviceOf(await s.login(victim.email, PASSWORD, '198.51.100.81'))!;
    const spy = argon2Spy();
    jest
      .spyOn(s.full.app.get(RedisService).client, 'zscore')
      .mockRejectedValue(new Error('redis down'));
    const res = await s.login(victim.email, PASSWORD, '198.51.100.81', device);
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(spy).not.toHaveBeenCalled();
    expect(s.sessionOf(res)).toBeUndefined();
  });

  it('(9) IPv6 /64 and IPv4-mapped addresses share buckets as specified', async () => {
    const a = await s.newUser();
    for (let i = 0; i < 5; i++)
      await s.login(a.email, WRONG, i % 2 ? '2001:db8::1' : '2001:db8::ffff');
    s.expectThrottled(await s.login(a.email, PASSWORD, '2001:db8::abcd'));
    s.expectSignedIn(await s.login(a.email, PASSWORD, '2001:db8:0:1::1'));

    const b = await s.newUser();
    for (let i = 0; i < 5; i++) await s.login(b.email, WRONG, '::ffff:203.0.113.7');
    s.expectThrottled(await s.login(b.email, PASSWORD, '203.0.113.7'));
  });

  it('(12) DEBT-596: a planted (attacker-chosen) device cookie is never adopted by the victim login', async () => {
    const victim = await s.newUser();
    const planted = 'P'.repeat(43);
    const res = await s.login(victim.email, PASSWORD, '198.51.100.120', planted);
    s.expectSignedIn(res);
    const issued = s.deviceOf(res)!;
    expect(issued).not.toBe(planted);
    expect(await s.redis.zscore(`dc:{u:${sha256(victim.sub)}}`, sha256(planted))).toBeNull();
    expect(await s.redis.zscore(`dc:{u:${sha256(victim.sub)}}`, sha256(issued))).not.toBeNull();
    // The planted value does not open the trusted-device path once the account bucket is full.
    for (let i = 0; i < 20; i++) await s.login(victim.email, WRONG, `198.18.2.${i % 5}`);
    s.expectThrottled(await s.login(victim.email, PASSWORD, '198.18.2.99', planted));
  });

  it('(13) DEBT-597: with a well-formed device cookie, existing and unknown emails cost the same trust lookups', async () => {
    const existing = await s.newUser();
    const ghost = `r85-ghost-${randomUUID()}@fixture.test`;
    const cookie = 'Q'.repeat(43);
    const zscore = jest.spyOn(s.full.app.get(RedisService).client, 'zscore');
    await s.login(existing.email, WRONG, '198.51.100.130', cookie);
    const forExisting = zscore.mock.calls.length;
    zscore.mockClear();
    await s.login(ghost, WRONG, '198.51.100.131', cookie);
    expect(forExisting).toBe(1);
    expect(zscore.mock.calls.length).toBe(forExisting);
  });

  it('(11) no hard lock: 30 failures leave lockedUntil/failedLoginCount untouched, no AUTH_ACCOUNT_LOCKED', async () => {
    const victim = await s.newUser();
    for (let i = 0; i < 30; i++) await s.login(victim.email, WRONG, `198.19.${i}.1`);
    const doc = await s.full.conn
      .model('User')
      .findById(victim.sub)
      .lean<{ lockedUntil?: Date; failedLoginCount?: number }>()
      .exec();
    expect(doc?.lockedUntil).toBeUndefined();
    expect(doc?.failedLoginCount ?? 0).toBe(0);
    expect(await s.audits(AuditAction.AUTH_ACCOUNT_LOCKED, victim.sub)).toHaveLength(0);
    // The owner on a new device is only bound by the account bucket, never by a stored lock.
    expect(await s.audits(AuditAction.AUTH_LOGIN_FAILED, victim.sub)).toHaveLength(20);
  });
});

describe('run 85 T4: device cookie attributes (real app, SESSION_COOKIE_SECURE=true)', () => {
  const s = suite(true);

  it('(10) __Host-idp_dc: Max-Age=7776000; Path=/; HttpOnly; Secure; SameSite=Lax; no Domain', async () => {
    const u = await s.newUser();
    const res = await s.login(u.email, PASSWORD, '198.51.100.90');
    s.expectSignedIn(res);
    const header = ([] as string[])
      .concat((res.headers['set-cookie'] as string[] | string | undefined) ?? [])
      .find((c) => c.startsWith('__Host-idp_dc='))!;
    expect(header).toBeDefined();
    expect(header).toMatch(/^__Host-idp_dc=[A-Za-z0-9_-]{43}; /);
    for (const attr of ['Max-Age=7776000', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) {
      expect(header.split('; ')).toContain(attr);
    }
    expect(header).not.toMatch(/Domain=/i);
    expect(
      ([] as string[])
        .concat((res.headers['set-cookie'] as string[] | string | undefined) ?? [])
        .some((c) => c.startsWith('idp_dc=')),
    ).toBe(false);
  });
});
