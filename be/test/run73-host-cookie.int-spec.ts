import { jest } from '@jest/globals';
import { seedBootstrap, type AdminSeedConfig } from '../src/database/seed';
import { SessionService } from '../src/modules/sessions/session.service';
import { bootFullApp, FULL_APP_ISSUER, type FullApp, type InjectResponse } from './full-app';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';

/**
 * Run 73 (DEBT-008) on the real app with `SESSION_COOKIE_SECURE=true`: the session and anonymous
 * CSRF cookies are `__Host-` (host-only, Path=/, Secure, never Domain), and the legacy names are
 * ignored after the rename (hard cut, no fallback) without a 5xx. Test-only credential.
 */
const ADMIN: AdminSeedConfig = {
  email: 'r73-admin@fixture.test',
  password: 'r73-int-admin-pass-1',
};

const setCookies = (res: InjectResponse): string[] =>
  ([] as string[]).concat((res.headers['set-cookie'] as string | string[] | undefined) ?? []);
const cookieOf = (res: InjectResponse, name: string): string | undefined =>
  setCookies(res).find((c) => c.startsWith(`${name}=`));
const pair = (header: string): string => header.split(';')[0];
const valueOf = (header: string): string => pair(header).split('=')[1];
const csrfOf = (res: InjectResponse): string => res.body.match(/name="_csrf" value="([^"]+)"/)![1];

const expectHostOnly = (header: string | undefined): void => {
  expect(header).toBeDefined();
  expect(header).toMatch(/; Secure/);
  expect(header).toMatch(/; HttpOnly/);
  expect(header).toMatch(/; SameSite=Lax/);
  expect(header).toMatch(/; Path=\/(;|$)/);
  expect(header).not.toMatch(/Domain=/i);
};

describe('run 73 DEBT-008: __Host- cookies when Secure (real app)', () => {
  let full: FullApp;
  let sessions: SessionService;

  const boot = async (): Promise<void> => {
    full = await bootFullApp({ name: 'r73-host', env: { SESSION_COOKIE_SECURE: 'true' } });
    sessions = full.app.get(SessionService);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await seedBootstrap(full.conn, ADMIN, FULL_APP_ISSUER, 'test');
    } finally {
      log.mockRestore();
    }
  };
  const booting = boot();
  beforeAll(() => booting, INT_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await settled(booting);
    await full?.close();
  });

  const get = (url: string, cookie?: string) =>
    full.app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
  const post = (url: string, cookie: string, payload: Record<string, string>) =>
    full.app.inject({ method: 'POST', url, headers: { cookie }, payload });

  /** Full chain via a cookie jar: GET /login -> POST /login -> the session cookie header. */
  async function login(): Promise<string> {
    const page = await get('/login');
    const anon = cookieOf(page, '__Host-idp_csrf')!;
    const res = await post('/login', pair(anon), {
      _csrf: csrfOf(page),
      email: ADMIN.email,
      password: ADMIN.password,
      returnTo: '/',
    });
    expect(res.statusCode).toBe(302);
    return cookieOf(res, '__Host-idp_session')!;
  }

  it('login page mints __Host-idp_csrf (host-only), never the legacy name', async () => {
    const page = await get('/login');
    expect(page.statusCode).toBe(200);
    expectHostOnly(cookieOf(page, '__Host-idp_csrf'));
    expect(cookieOf(page, 'idp_csrf')).toBeUndefined();
  });

  it('login sets __Host-idp_session (host-only) and the next request is signed in', async () => {
    const session = await login();
    expectHostOnly(session);
    expect(session).toMatch(/; Max-Age=86400/);
    expect(await sessions.get(valueOf(session))).not.toBeNull();
    const home = await get('/', pair(session));
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('Signed in');
  });

  it('a valid session id under the legacy idp_session name is ignored => anonymous, no 5xx', async () => {
    const id = valueOf(await login());
    const home = await get('/', `idp_session=${id}`);
    expect(home.statusCode).toBe(302);
    expect(home.headers['location']).toBe('/login');
    const page = await get('/login', `idp_session=${id}`);
    expect(page.statusCode).toBe(200); // the form, not the "already signed in" redirect
    expect(cookieOf(page, '__Host-idp_csrf')).toBeDefined(); // anonymous CSRF identity minted
    expect(await sessions.get(id)).not.toBeNull(); // not destroyed either (hard cut, no cleanup)
  });

  it('CSRF bound to a legacy idp_csrf identity is refused (no login, no session cookie)', async () => {
    const page = await get('/login');
    const anon = valueOf(cookieOf(page, '__Host-idp_csrf')!);
    // The same identity value under the legacy name (what a sibling subdomain could toss).
    const res = await post('/login', `idp_csrf=${anon}`, {
      _csrf: csrfOf(page),
      email: ADMIN.email,
      password: ADMIN.password,
      returnTo: '/',
    });
    expect(res.statusCode).toBe(403);
    expect(cookieOf(res, '__Host-idp_session')).toBeUndefined();
    expect(cookieOf(res, 'idp_session')).toBeUndefined();
  });

  it('logout via the legacy session name does not revoke the live session; via __Host- it does', async () => {
    const session = await login();
    const id = valueOf(session);
    const logoutPage = await get('/logout', pair(session));
    const csrf = csrfOf(logoutPage);
    const legacy = await post('/logout', `idp_session=${id}`, { _csrf: csrf });
    expect(legacy.statusCode).toBe(403);
    expect(await sessions.get(id)).not.toBeNull();

    const real = await post('/logout', pair(session), { _csrf: csrf });
    expect(real.statusCode).toBe(302);
    expect(await sessions.get(id)).toBeNull();
    const cleared = cookieOf(real, '__Host-idp_session');
    expectHostOnly(cleared);
    expect(cleared).toMatch(/Max-Age=0/);
    // Replay of the old cookie after logout => anonymous.
    expect((await get('/', pair(session))).statusCode).toBe(302);
  });
});
