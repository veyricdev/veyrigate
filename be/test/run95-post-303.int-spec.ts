import { jest } from '@jest/globals';
import { randomBytes, randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { deriveS256Challenge } from '../src/common/crypto/pkce.util';
import { FederationService } from '../src/modules/federation/federation.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { UserService } from '../src/modules/identity/user.service';
import { MFA_KEYRING, type MfaKeyring } from '../src/modules/mfa/mfa-crypto';
import { totpAt, totpStep } from '../src/modules/mfa/totp';
import { AuthorizeRedirectError } from '../src/modules/oauth/authorize/authorize.errors';
import { AuthorizeService } from '../src/modules/oauth/authorize/authorize.service';
import { CsrfService } from '../src/modules/ui/csrf.service';
import {
  bootFullApp,
  FLOW_API_AUD,
  FLOW_REDIRECT,
  seedFlowClient,
  type FullApp,
  type InjectResponse,
} from './full-app';
import { enrollForTest } from './helpers/mfa';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';

/**
 * Run 95 T3 (DEBT-570, D95.15/D95.17): every redirect answered by a UI/consent/federation `@Post`
 * handler is `303 See Other` (RFC 9110 §15.4.4) with the same `Location` as before; `@Get`
 * handlers keep `302`. One redirect branch per POST route, plus three GET controls.
 */
const PASSWORD = 'r95p-Current#Pass-1';
const SECRET = Buffer.from('r95-post-303-seed!!!', 'ascii');
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0';

const setCookies = (res: InjectResponse): string[] =>
  ([] as string[]).concat((res.headers['set-cookie'] as string | string[] | undefined) ?? []);
const pairOf = (res: InjectResponse, name: string) =>
  setCookies(res)
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0];
const csrfOf = (res: InjectResponse): string => res.body.match(/name="_csrf" value="([^"]+)"/)![1];
const ip = () => `198.51.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

describe('run 95 T3: POST redirects are 303, GET redirects stay 302 (real app)', () => {
  let full: FullApp;
  let client: { clientId: string; secret: string };
  let keyring: MfaKeyring;
  let csrf: CsrfService;
  let setup: Promise<void> | undefined;
  beforeAll(
    () =>
      (setup = (async () => {
        full = await bootFullApp({ name: 'run95-post-303' });
        client = await seedFlowClient(full);
        keyring = full.app.get<MfaKeyring>(MFA_KEYRING);
        csrf = full.app.get(CsrfService);
      })()),
    INT_SETUP_TIMEOUT_MS,
  );
  afterAll(async () => {
    await settled(setup);
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);
  afterEach(() => jest.restoreAllMocks());

  const inject = (o: Record<string, unknown>) => full.app.inject(o) as Promise<InjectResponse>;
  const newUser = async (enroll = false) => {
    const email = `r95p-${randomUUID()}@fixture.test`;
    const users = full.app.get(UserService);
    const u = await users.create({ email, password: PASSWORD });
    await users.verifyEmail(u.sub);
    await full.conn
      .model('UserTenant')
      .create({ userId: new Types.ObjectId(u.sub), tenantId: DEFAULT_TENANT_ID, status: 'active' });
    if (enroll) await enrollForTest(full.conn, keyring, u.sub, SECRET);
    return { email, sub: u.sub };
  };
  /** Anonymous form identity (the `idp_csrf` cookie of `GET /login`) + its token. */
  const anon = async (from = ip()) => {
    const page = await inject({
      method: 'GET',
      url: '/login',
      remoteAddress: from,
      headers: { 'user-agent': UA },
    });
    return { cookie: pairOf(page, 'idp_csrf')!, token: csrfOf(page), from };
  };
  const postLogin = async (email: string, returnTo = '/account/sessions') => {
    const a = await anon();
    return inject({
      method: 'POST',
      url: '/login',
      remoteAddress: a.from,
      headers: { cookie: a.cookie, 'user-agent': UA },
      payload: { _csrf: a.token, email, password: PASSWORD, returnTo },
    });
  };
  /** A signed-in jar (`idp_session=<id>`) and the session-bound CSRF token. */
  const signIn = async () => {
    const u = await newUser();
    const res = await postLogin(u.email, '/');
    const jar = pairOf(res, 'idp_session')!;
    return { jar, token: csrf.token(jar.split('=')[1]) };
  };
  /** POST with the anonymous identity (no session cookie). */
  const anonPost = async (url: string, payload: Record<string, string> = {}) => {
    const a = await anon();
    return inject({
      method: 'POST',
      url,
      remoteAddress: a.from,
      headers: { cookie: a.cookie, 'user-agent': UA },
      payload: { _csrf: a.token, ...payload },
    });
  };
  const authorize = (jar?: string) =>
    inject({
      method: 'GET',
      url: `/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: client.clientId,
        redirect_uri: FLOW_REDIRECT,
        scope: 'openid api.read',
        resource: FLOW_API_AUD,
        state: 'r95-state',
        nonce: 'n',
        code_challenge: deriveS256Challenge(randomBytes(32).toString('base64url')),
        code_challenge_method: 'S256',
      }).toString()}`,
      headers: jar ? { cookie: jar } : {},
    });

  describe('POST /login', () => {
    it('signed in => 303 to returnTo', async () => {
      const u = await newUser();
      const res = await postLogin(u.email);
      expect(res.statusCode).toBe(303);
      expect(res.headers['location']).toBe('/account/sessions');
      expect(pairOf(res, 'idp_session')).toBeDefined();
    });
    it('MFA enrolled => 303 /login/mfa with a ticket', async () => {
      const u = await newUser(true);
      const res = await postLogin(u.email);
      expect(res.statusCode).toBe(303);
      expect(res.headers['location']).toBe('/login/mfa');
      expect(pairOf(res, 'idp_mfa')).toBeDefined();
    });
  });

  describe('POST /login/mfa', () => {
    it('no ticket => 303 /login', async () => {
      const res = await inject({
        method: 'POST',
        url: '/login/mfa',
        remoteAddress: ip(),
        payload: { _csrf: 'x', code: '000000' },
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers['location']).toBe('/login');
    });
    it('unknown (expired) ticket => 303 /login', async () => {
      const ticket = randomBytes(24).toString('base64url');
      const res = await inject({
        method: 'POST',
        url: '/login/mfa',
        remoteAddress: ip(),
        headers: { cookie: `idp_mfa=${ticket}` },
        payload: { _csrf: csrf.token(ticket), code: '000000' },
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers['location']).toBe('/login');
    });
    it('right code => 303 to returnTo', async () => {
      const u = await newUser(true);
      const step1 = await postLogin(u.email);
      const ticket = pairOf(step1, 'idp_mfa')!;
      const form = await inject({ method: 'GET', url: '/login/mfa', headers: { cookie: ticket } });
      expect(form.statusCode).toBe(200);
      const res = await inject({
        method: 'POST',
        url: '/login/mfa',
        remoteAddress: ip(),
        headers: { cookie: ticket, 'user-agent': UA },
        payload: { _csrf: csrfOf(form), code: totpAt(SECRET, totpStep(Date.now())) },
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers['location']).toBe('/account/sessions');
      expect(pairOf(res, 'idp_session')).toBeDefined();
    });
  });

  it('POST /account/password without a session => 303 /login', async () => {
    const res = await anonPost('/account/password', {
      current_password: PASSWORD,
      new_password: 'r95p-Next#Pass-22',
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers['location']).toBe('/login');
  });

  describe('POST /logout', () => {
    it('no session => 303 to the default redirect', async () => {
      const res = await anonPost('/logout');
      expect(res.statusCode).toBe(303);
      expect(res.headers['location']).toBe('/login?loggedOut=1');
    });
    it('live session => 303 to the default redirect, and the session is gone', async () => {
      const s = await signIn();
      const res = await inject({
        method: 'POST',
        url: '/logout',
        headers: { cookie: s.jar },
        payload: { _csrf: s.token },
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers['location']).toBe('/login?loggedOut=1');
      const after = await inject({
        method: 'GET',
        url: '/account/sessions',
        headers: { cookie: s.jar },
      });
      expect(after.statusCode).toBe(302);
    });
  });

  it.each(['start', 'confirm', 'disable', 'recovery'])(
    'POST /account/mfa/%s without a session => 303 /login?returnTo=/account/mfa',
    async (step) => {
      const res = await anonPost(`/account/mfa/${step}`);
      expect(res.statusCode).toBe(303);
      expect(res.headers['location']).toBe('/login?returnTo=%2Faccount%2Fmfa');
    },
  );

  it.each([
    ['/account/sessions/revoke', '/login?returnTo=%2Faccount%2Fsessions'],
    ['/account/sessions/revoke-others', '/login?returnTo=%2Faccount%2Fsessions'],
    ['/account/devices/forget', '/login?returnTo=%2Faccount%2Fsessions'],
    ['/account/devices/forget-others', '/login?returnTo=%2Faccount%2Fsessions'],
    ['/account/apps/revoke', '/login?returnTo=%2Faccount%2Fapps'],
  ])('POST %s without a session => 303 %s', async (url, location) => {
    const res = await anonPost(url);
    expect(res.statusCode).toBe(303);
    expect(res.headers['location']).toBe(location);
  });

  describe('POST /auth/link', () => {
    const outcome = (o: unknown) => {
      jest.spyOn(full.app.get(FederationService), 'pendingLink').mockResolvedValue(null as never);
      jest.spyOn(full.app.get(FederationService), 'completeLink').mockResolvedValue(o as never);
    };
    it('linked => 303 to the resume location', async () => {
      outcome({ kind: 'linked', location: '/authorize?request_id=r95', sessionId: 'r95-sid' });
      const res = await anonPost('/auth/link', { password: PASSWORD });
      expect(res.statusCode).toBe(303);
      expect(res.headers['location']).toBe('/authorize?request_id=r95');
    });
    it('MFA pending => 303 /login/mfa', async () => {
      outcome({ kind: 'mfa', ticketId: 'r95-ticket' });
      const res = await anonPost('/auth/link', { password: PASSWORD });
      expect(res.statusCode).toBe(303);
      expect(res.headers['location']).toBe('/login/mfa');
    });
  });

  describe('POST /authorize/consent', () => {
    const consentScreen = async () => {
      const s = await signIn();
      const screen = await authorize(s.jar);
      expect(screen.statusCode).toBe(200);
      const requestId = screen.body.match(/name="request_id" value="([^"]+)"/)![1];
      return { jar: s.jar, token: csrfOf(screen), requestId };
    };
    const decide = (c: { jar: string; token: string; requestId: string }, approve: string) =>
      inject({
        method: 'POST',
        url: '/authorize/consent',
        headers: { cookie: c.jar },
        payload: { _csrf: c.token, request_id: c.requestId, approve },
      });

    it('no session => 303 /login', async () => {
      const res = await anonPost('/authorize/consent', { request_id: 'r95', approve: 'true' });
      expect(res.statusCode).toBe(303);
      expect(res.headers['location']).toBe('/login');
    });
    it('approve => 303 to redirect_uri with code/state/iss', async () => {
      const res = await decide(await consentScreen(), 'true');
      expect(res.statusCode).toBe(303);
      const loc = new URL(String(res.headers['location']));
      expect(`${loc.origin}${loc.pathname}`).toBe(FLOW_REDIRECT);
      expect(loc.searchParams.get('code')).toBeTruthy();
      expect(loc.searchParams.get('state')).toBe('r95-state');
    });
    it('deny => 303 to redirect_uri with error=access_denied', async () => {
      const res = await decide(await consentScreen(), 'false');
      expect(res.statusCode).toBe(303);
      const loc = new URL(String(res.headers['location']));
      expect(loc.searchParams.get('error')).toBe('access_denied');
      expect(loc.searchParams.get('code')).toBeNull();
    });
    it('redirect error from the service => 303 to redirect_uri with the error', async () => {
      const c = await consentScreen();
      const err = new AuthorizeRedirectError('invalid_scope');
      err.redirectUri = FLOW_REDIRECT;
      err.state = 'r95-state';
      jest.spyOn(full.app.get(AuthorizeService), 'decideConsent').mockRejectedValue(err);
      const res = await decide(c, 'true');
      expect(res.statusCode).toBe(303);
      const loc = new URL(String(res.headers['location']));
      expect(`${loc.origin}${loc.pathname}`).toBe(FLOW_REDIRECT);
      expect(loc.searchParams.get('error')).toBe('invalid_scope');
    });
    it('expired request => 400 page (not a redirect, unchanged)', async () => {
      const s = await signIn();
      const res = await decide({ jar: s.jar, token: s.token, requestId: 'r95-gone' }, 'true');
      expect(res.statusCode).toBe(400);
      expect(res.headers['location']).toBeUndefined();
    });
  });

  describe('GET controls keep 302', () => {
    it('GET /authorize without a session => 302 /login?returnTo=...', async () => {
      const res = await authorize();
      expect(res.statusCode).toBe(302);
      expect(String(res.headers['location'])).toMatch(/^\/login\?returnTo=/);
    });
    it('GET /account/sessions without a session => 302', async () => {
      const res = await inject({ method: 'GET', url: '/account/sessions' });
      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toBe('/login?returnTo=%2Faccount%2Fsessions');
    });
    it('GET /login/mfa without a ticket => 302 /login', async () => {
      const res = await inject({ method: 'GET', url: '/login/mfa' });
      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toBe('/login');
    });
  });
});
