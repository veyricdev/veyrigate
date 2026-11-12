import { jest } from '@jest/globals';
import { randomBytes, randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { sha256 } from '../src/common/crypto/crypto.util';
import { RedisService } from '../src/database/redis/redis.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { UserService } from '../src/modules/identity/user.service';
import { RefreshTokenService } from '../src/modules/oauth/token/refresh-token.service';
import { AuditAction } from '../src/modules/security/audit/audit-action.enum';
import { SessionService } from '../src/modules/sessions/session.service';
import {
  authorizeCode,
  bootFullApp,
  FLOW_API_AUD,
  FLOW_REDIRECT,
  formPost,
  seedFlowClient,
  type FullApp,
  type InjectResponse,
} from './full-app';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';
import { seedConsent } from './oauth-fixtures';

/**
 * Run 88 T2 (C-7.5.2, DEBT-582/586, D88.15–D88.20) on the REAL app over HTTP: `/account/sessions`
 * lists the user's sessions + trusted devices; signing out one / every other session needs a recent
 * authentication (< 5') or the current password (shared bucket with `/account/password`), only
 * touches the CURRENT user's sessions, and runs the local-logout sequence (families → session +
 * tombstone → sweep). Forgetting a trusted device never signs it out.
 */
const PASSWORD = 'r88s-Current#Pass-1';
const SCOPE = 'openid email offline_access api.read';
const UA_A =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const UA_B = 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0';

const setCookies = (res: InjectResponse): string[] =>
  ([] as string[]).concat((res.headers['set-cookie'] as string | string[] | undefined) ?? []);
const pairOf = (res: InjectResponse, name: string) =>
  setCookies(res)
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0];
const csrfOf = (res: InjectResponse): string => res.body.match(/name="_csrf" value="([^"]+)"/)![1];

describe('run 88 T2: /account/sessions (real app)', () => {
  let full: FullApp;
  let bff: { clientId: string; secret: string };
  let redis: RedisService['client'];
  let sessions: SessionService;

  const boot = async (): Promise<void> => {
    full = await bootFullApp({ name: 'run88-sessions' });
    bff = await seedFlowClient(full);
    redis = full.app.get(RedisService).client;
    sessions = full.app.get(SessionService);
  };
  let setup: Promise<void> | undefined;
  beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await settled(setup);
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);
  afterEach(() => jest.restoreAllMocks());

  const newUser = async (password: string | null = PASSWORD) => {
    const email = `r88s-${randomUUID()}@fixture.test`;
    const users = full.app.get(UserService);
    const u = await users.create({ email, ...(password ? { password } : {}) });
    await users.verifyEmail(u.sub);
    await full.conn
      .model('UserTenant')
      .create({ userId: new Types.ObjectId(u.sub), tenantId: DEFAULT_TENANT_ID, status: 'active' });
    return { email, sub: u.sub };
  };
  const ip = () => `198.51.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

  /** Real browser sign-in with a User-Agent; returns the cookie jar (session + device cookie). */
  const login = async (email: string, ua = UA_A, from = ip()) => {
    const page = (await full.app.inject({
      method: 'GET',
      url: '/login',
      remoteAddress: from,
      headers: { 'user-agent': ua },
    })) as InjectResponse;
    const anon = pairOf(page, 'idp_csrf')!;
    const res = (await full.app.inject({
      method: 'POST',
      url: '/login',
      remoteAddress: from,
      headers: { cookie: anon, 'user-agent': ua },
      payload: { _csrf: csrfOf(page), email, password: PASSWORD, returnTo: '/' },
    })) as InjectResponse;
    const session = pairOf(res, 'idp_session')!;
    const device = pairOf(res, 'idp_dc');
    const id = session.split('=')[1];
    return {
      id,
      ref: sha256(id),
      device: device?.split('=')[1],
      ua,
      ip: from,
      jar: [session, device].filter(Boolean).join('; '),
    };
  };
  type Browser = Awaited<ReturnType<typeof login>>;

  const page = (b?: Pick<Browser, 'jar' | 'ua'>) =>
    full.app.inject({
      method: 'GET',
      url: '/account/sessions',
      headers: b ? { cookie: b.jar, 'user-agent': b.ua } : {},
    }) as Promise<InjectResponse>;
  const post = async (
    b: Pick<Browser, 'jar' | 'ua'>,
    path: string,
    fields: Record<string, string> = {},
    csrf?: string,
  ) => {
    const form = await page(b);
    return full.app.inject({
      method: 'POST',
      url: path,
      headers: { cookie: b.jar, 'user-agent': b.ua },
      payload: { _csrf: csrf ?? csrfOf(form), ...fields },
    }) as Promise<InjectResponse>;
  };

  /** Push the session's authentication `ms` into the past (re-auth window, D88.18). */
  const age = async (ref: string, ms = 301_000) => {
    const raw = (await redis.get(`sess:${ref}`))!;
    const data = JSON.parse(raw) as { authTime: number };
    data.authTime -= ms;
    await redis.set(`sess:${ref}`, JSON.stringify(data), 'KEEPTTL');
  };
  /** Refresh family (and access token) minted through `/authorize` + `/token` for session `b`. */
  const family = async (sub: string, b: Browser) => {
    await seedConsent(full.conn, {
      userId: sub,
      clientId: bff.clientId,
      resource: FLOW_API_AUD,
      scopes: SCOPE.split(' '),
    });
    const verifier = randomBytes(32).toString('base64url');
    const code = await authorizeCode(full, {
      clientId: bff.clientId,
      sessionId: b.id,
      resource: FLOW_API_AUD,
      scope: SCOPE,
      verifier,
    });
    return { code, verifier };
  };
  const exchange = async (f: { code: string; verifier: string }) =>
    (
      await formPost(full, '/token', bff, {
        grant_type: 'authorization_code',
        code: f.code,
        redirect_uri: FLOW_REDIRECT,
        code_verifier: f.verifier,
        resource: FLOW_API_AUD,
      })
    ).json<{ access_token: string; refresh_token: string }>();
  const activeFamilies = (ref: string) =>
    full.conn.collection('refreshtokens').countDocuments({ sessionRef: ref, revokedAt: null });
  const audits = (sub: string, action: AuditAction) =>
    full.conn
      .model('AuditLog')
      .find({ action, actorId: sub })
      .sort({ _id: 1 })
      .lean<Array<Record<string, unknown>>>()
      .exec();

  it('AC1 two browsers => both listed with allowlisted labels, "This browser" once, no IP/UA/email, no-store; no session => 302', async () => {
    const u = await newUser();
    const a = await login(u.email, UA_A);
    const b = await login(u.email, UA_B);
    const res = await page(a);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('Chrome on Windows');
    expect(res.body).toContain('Firefox on Linux');
    expect(res.body.match(/This browser/g)?.length).toBe(2); // one session row + one device row
    expect(res.body).toContain(`value="${b.ref}"`);
    expect(res.body).not.toContain(`value="${a.ref}"`); // the current one has no revoke form
    for (const leak of [a.ip, b.ip, UA_A, UA_B, u.email, 'Gecko/20100101']) {
      expect(res.body).not.toContain(leak);
    }
    expect(res.body).toContain('action="/logout?scope=all"');
    const home = await full.app.inject({ method: 'GET', url: '/', headers: { cookie: a.jar } });
    expect(home.body).toContain('href="/account/sessions"');

    const anon = await page();
    expect(anon.statusCode).toBe(302);
    expect(anon.headers['location']).toBe('/login?returnTo=%2Faccount%2Fsessions');
  });

  it('AC2 fresh A signs out B => 303; B gone + tombstone; B family revoked, A family alive; B AT dead; B back to login; audits', async () => {
    const u = await newUser();
    const a = await login(u.email, UA_A);
    const b = await login(u.email, UA_B);
    const tb = await exchange(await family(u.sub, b));
    const ta = await exchange(await family(u.sub, a));
    expect(await activeFamilies(b.ref)).toBe(1);

    const res = await post(a, '/account/sessions/revoke', { ref: b.ref });
    expect(res.statusCode).toBe(303);
    expect(res.headers['location']).toBe('/account/sessions?done=session');
    expect(await redis.exists(`sess:${b.ref}`)).toBe(0);
    expect(await redis.exists(`sess_end:${b.ref}`)).toBe(1);
    expect(await activeFamilies(b.ref)).toBe(0);
    expect(await activeFamilies(a.ref)).toBe(1);

    const userinfo = await full.app.inject({
      method: 'GET',
      url: '/userinfo',
      headers: { authorization: `Bearer ${tb.access_token}` },
    });
    expect(userinfo.statusCode).toBe(401);
    const intro = await formPost(full, '/introspect', bff, { token: tb.access_token });
    expect(intro.json()).toEqual({ active: false });
    const stillA = await full.app.inject({
      method: 'GET',
      url: '/userinfo',
      headers: { authorization: `Bearer ${ta.access_token}` },
    });
    expect(stillA.statusCode).toBe(200);
    const bNext = await full.app.inject({ method: 'GET', url: '/', headers: { cookie: b.jar } });
    expect(bNext.statusCode).toBe(302);
    expect(bNext.headers['location']).toBe('/login');

    const revoked = await audits(u.sub, AuditAction.SESSION_REVOKED);
    expect(revoked.at(-1)).toMatchObject({
      result: 'success',
      targetId: b.ref,
      metadata: { scope: 'session', via: 'self' },
    });
    expect((await audits(u.sub, AuditAction.TOKEN_REVOKED)).at(-1)).toMatchObject({
      result: 'success',
      metadata: { scope: 'session', via: 'self', count: 1 },
    });
    const done = (await full.app.inject({
      method: 'GET',
      url: String(res.headers['location']),
      headers: { cookie: a.jar },
    })) as InjectResponse;
    expect(done.body).toContain('The session was signed out.');
  });

  it('AC3 stale session: no password => 400; wrong => 400 + reauth_failed; right => 303; 6th wrong in the window => 429', async () => {
    const u = await newUser();
    const a = await login(u.email, UA_A);
    const b = await login(u.email, UA_B);
    await age(a.ref);
    const form = await page(a);
    expect(form.body).toContain('name="current_password"');

    const none = await post(a, '/account/sessions/revoke', { ref: b.ref });
    expect(none.statusCode).toBe(400);
    expect(await redis.exists(`sess:${b.ref}`)).toBe(1);

    const wrong = await post(a, '/account/sessions/revoke', {
      ref: b.ref,
      current_password: 'not-the-password',
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.body).toContain('The current password is incorrect.');
    expect(wrong.body).not.toContain('not-the-password');
    expect(await redis.exists(`sess:${b.ref}`)).toBe(1);
    expect((await audits(u.sub, AuditAction.SESSION_REVOKED)).at(-1)).toMatchObject({
      result: 'failure',
      reason: 'reauth_failed',
    });

    const right = await post(a, '/account/sessions/revoke', {
      ref: b.ref,
      current_password: PASSWORD,
    });
    expect(right.statusCode).toBe(303);
    expect(await redis.exists(`sess:${b.ref}`)).toBe(0);

    // The bucket is the `/account/password` one (5/900 s per user): 6 wrong in a row => 429 on the 6th.
    const w = await newUser();
    const wa = await login(w.email, UA_A);
    const c = await login(w.email, UA_B);
    await age(wa.ref);
    for (let i = 0; i < 5; i++) {
      const r = await post(wa, '/account/sessions/revoke', {
        ref: c.ref,
        current_password: 'nope',
      });
      expect(r.statusCode).toBe(400);
    }
    const sixth = await post(wa, '/account/sessions/revoke', {
      ref: c.ref,
      current_password: PASSWORD,
    });
    expect(sixth.statusCode).toBe(429);
    expect(await redis.exists(`sess:${c.ref}`)).toBe(1);
  });

  it("AC4 another user's ref / unknown / malformed => fixed 404, nothing changes, ref not audited; current ref => 400", async () => {
    const u = await newUser();
    const v = await newUser();
    const a = await login(u.email);
    const other = await login(v.email, UA_B);
    const keysBefore = (await redis.keys('sess:*')).sort();
    const bodies: string[] = [];
    for (const ref of [other.ref, sha256(randomUUID()), 'xyz', other.ref.toUpperCase()]) {
      const res = await post(a, '/account/sessions/revoke', { ref });
      expect(res.statusCode).toBe(404);
      bodies.push(res.body);
    }
    expect(new Set(bodies).size).toBe(1);
    expect((await redis.keys('sess:*')).sort()).toEqual(keysBefore);
    const fails = await audits(u.sub, AuditAction.SESSION_REVOKED);
    expect(fails.every((e) => e.result === 'failure' && e.reason === 'not_found')).toBe(true);
    expect(JSON.stringify(fails)).not.toContain(other.ref);

    const self = await post(a, '/account/sessions/revoke', { ref: a.ref });
    expect(self.statusCode).toBe(400);
    expect(self.body).toContain('use Sign out');
    expect(await redis.exists(`sess:${a.ref}`)).toBe(1);
    expect(await redis.exists(`sess:${other.ref}`)).toBe(1);
  });

  it('AC5 missing _csrf / CSRF of another identity => 403, nothing changes', async () => {
    const u = await newUser();
    const v = await newUser();
    const a = await login(u.email);
    const b = await login(u.email, UA_B);
    const other = await login(v.email);
    const noCsrf = await full.app.inject({
      method: 'POST',
      url: '/account/sessions/revoke',
      headers: { cookie: a.jar },
      payload: { ref: b.ref },
    });
    expect(noCsrf.statusCode).toBe(403);
    const foreign = await post(a, '/account/sessions/revoke-others', {}, csrfOf(await page(other)));
    expect(foreign.statusCode).toBe(403);
    expect(await redis.exists(`sess:${b.ref}`)).toBe(1);
  });

  it('AC6 sign out every other session (3 sessions) => only the current one left, its family alive; audit count 2', async () => {
    const u = await newUser();
    const a = await login(u.email, UA_A);
    const b = await login(u.email, UA_B);
    const c = await login(u.email, UA_B);
    await exchange(await family(u.sub, a));
    await exchange(await family(u.sub, b));
    await exchange(await family(u.sub, c));
    const res = await post(a, '/account/sessions/revoke-others');
    expect(res.statusCode).toBe(303);
    expect((await sessions.listByUser(u.sub)).map((s) => s.ref)).toEqual([a.ref]);
    expect(await activeFamilies(a.ref)).toBe(1);
    expect(await activeFamilies(b.ref)).toBe(0);
    expect(await activeFamilies(c.ref)).toBe(0);
    expect((await audits(u.sub, AuditAction.SESSION_REVOKED)).at(-1)).toMatchObject({
      result: 'success',
      metadata: { scope: 'others', via: 'self', count: 2 },
    });
  });

  it('AC7 race: /token exchanges a code of B between the family revoke and the session delete (x20) => no live family of B', async () => {
    const u = await newUser();
    const a = await login(u.email, UA_A);
    const rts = full.app.get(RefreshTokenService);
    for (let i = 0; i < 20; i++) {
      const b = await login(u.email, UA_B);
      const f = await family(u.sub, b);
      const real = rts.revokeForSession.bind(rts);
      let minted: Promise<unknown> = Promise.resolve();
      const spy = jest.spyOn(rts, 'revokeForSession').mockImplementationOnce(async (...args) => {
        const n = await real(...args);
        minted = exchange(f); // B still exists: `/token` mints a family for it
        await minted;
        return n;
      });
      const res = await post(a, '/account/sessions/revoke', { ref: b.ref });
      spy.mockRestore();
      await minted;
      expect(res.statusCode).toBe(303);
      expect(
        await full.conn.collection('refreshtokens').countDocuments({ sessionRef: b.ref }),
      ).toBe(1);
      expect(await activeFamilies(b.ref)).toBe(0);
    }
  }, 120_000);

  it('AC8 Mongo fault at the family step => 5xx, B alive, failedStep pre_revoke; Redis fault at delete => failedStep sessions; retry => 303', async () => {
    const u = await newUser();
    const a = await login(u.email, UA_A);
    const b = await login(u.email, UA_B);
    const leak = 'mongodb://u:r88-S3CRET@h boom';
    jest
      .spyOn(full.app.get(RefreshTokenService), 'revokeForSession')
      .mockRejectedValueOnce(new Error(leak));
    const first = await post(a, '/account/sessions/revoke', { ref: b.ref });
    expect(first.statusCode).toBeGreaterThanOrEqual(500);
    expect(first.body).not.toContain('r88-S3CRET');
    expect(await redis.exists(`sess:${b.ref}`)).toBe(1);
    expect((await audits(u.sub, AuditAction.SESSION_REVOKED)).at(-1)).toMatchObject({
      result: 'failure',
      reason: 'revoke_failed',
      metadata: { scope: 'session', via: 'self', failedStep: 'pre_revoke' },
    });

    jest.spyOn(sessions, 'revokeByDevice').mockRejectedValueOnce(new Error('redis down'));
    const second = await post(a, '/account/sessions/revoke', { ref: b.ref });
    expect(second.statusCode).toBeGreaterThanOrEqual(500);
    expect((await audits(u.sub, AuditAction.SESSION_REVOKED)).at(-1)).toMatchObject({
      metadata: { failedStep: 'sessions' },
    });
    jest.restoreAllMocks();

    const retry = await post(a, '/account/sessions/revoke', { ref: b.ref });
    expect(retry.statusCode).toBe(303);
    expect(await redis.exists(`sess:${b.ref}`)).toBe(0);
  });

  it('AC9 trusted devices: listed, "This browser"; forget B keeps B signed in; forget others; unknown => 404; audits', async () => {
    const u = await newUser();
    const a = await login(u.email, UA_A);
    const b = await login(u.email, UA_B);
    const ha = sha256(a.device!);
    const hb = sha256(b.device!);
    const key = `dc:{u:${sha256(u.sub)}}`;
    const list = await page(a);
    expect(list.body.match(/Trusted since \d{4}-\d{2}-\d{2}/g)?.length).toBe(2);
    expect(list.body).toContain(`value="${hb}"`);

    const forget = await post(a, '/account/devices/forget', { device: hb });
    expect(forget.statusCode).toBe(303);
    expect(await redis.zscore(key, hb)).toBeNull();
    expect(await redis.zscore(key, ha)).not.toBeNull();
    expect(await redis.exists(`sess:${b.ref}`)).toBe(1); // forgetting never signs out

    const unknown = await post(a, '/account/devices/forget', { device: hb });
    expect(unknown.statusCode).toBe(404);

    // Another user's device hash cannot be reached: the key is derived from the current user.
    const v = await newUser();
    const other = await login(v.email);
    const foreign = await post(a, '/account/devices/forget', { device: sha256(other.device!) });
    expect(foreign.statusCode).toBe(404);
    expect(await redis.zscore(`dc:{u:${sha256(v.sub)}}`, sha256(other.device!))).not.toBeNull();

    await login(u.email, UA_B);
    expect(await redis.zcard(key)).toBe(2);
    const others = await post(a, '/account/devices/forget-others');
    expect(others.statusCode).toBe(303);
    expect(await redis.zrange(key, '0', '-1')).toEqual([ha]);
    const events = await audits(u.sub, AuditAction.TRUSTED_DEVICE_REVOKED);
    expect(events.map((e) => [e.result, (e.metadata as Record<string, unknown>)?.scope])).toEqual([
      ['success', 'device'],
      ['failure', 'device'],
      ['failure', 'device'],
      ['success', 'others'],
    ]);
  });

  it('AC10 federated session => "Google/GitHub sign-in"; a session without a label => "Unknown device"', async () => {
    const u = await newUser();
    const a = await login(u.email);
    await sessions.create(u.sub, DEFAULT_TENANT_ID, { amr: ['fed'] });
    const res = await page(a);
    expect(res.body).toContain('Google/GitHub sign-in');
    expect(res.body).toContain('Unknown device');
  });

  it("AC12 account without a password, session older than 5' => explanation instead of the field; POST => 400, nothing changes", async () => {
    const u = await newUser(null);
    const s = await sessions.create(u.sub, DEFAULT_TENANT_ID, { amr: ['fed'] });
    const other = await sessions.create(u.sub, DEFAULT_TENANT_ID, { amr: ['fed'] });
    await age(s.session.ref);
    const browser = { jar: `idp_session=${s.id}`, ua: UA_A };
    const res = await page(browser);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('sign out and sign in again');
    expect(res.body).not.toContain('name="current_password"');
    const post400 = await post(browser, '/account/sessions/revoke', {
      ref: other.session.ref,
      current_password: 'anything-at-all',
    });
    expect(post400.statusCode).toBe(400);
    expect(await redis.exists(`sess:${other.session.ref}`)).toBe(1);
  });
});
