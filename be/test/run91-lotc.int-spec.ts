import { randomBytes } from 'node:crypto';
import { deriveS256Challenge } from '../src/common/crypto/pkce.util';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { SESSION_COOKIE } from '../src/modules/sessions/session.cookie';
import { SessionService } from '../src/modules/sessions/session.service';
import {
  bootFullApp,
  FLOW_API_AUD,
  FLOW_REDIRECT,
  FULL_APP_ISSUER,
  seedFlowClient,
  type FullApp,
  type InjectResponse,
} from './full-app';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';
import { seedConsent, seedOAuthUser } from './oauth-fixtures';

/**
 * Run 91 lot C (T5) on the REAL app, without TRUST_PROXY:
 * - DEBT-662: `/authorize` accepts `response_mode` only absent or `query`; anything else is
 *   `invalid_request` to the trusted redirect_uri (fixed description, state + iss, no code), or the
 *   first-party 400 page before the redirect_uri is trusted. Discovery: `response_modes_supported`.
 * - DEBT-663 (D91.12): every session/CSRF dependent HTML page is `Cache-Control: no-store`, `/` too.
 * - DEBT-667 (d) (D91.10): with no TRUST_PROXY a client `x-request-id` is never used; the audit
 *   `requestId` equals the echoed response header (the trusted case: `run90-backend.int-spec.ts`).
 */
const STATE = 'rp-state-r91c';

describe('run 91 lot C: response_mode, no-store pages, request id without TRUST_PROXY', () => {
  let full: FullApp;
  let bff: { clientId: string; secret: string };
  let userId = '';

  let setup: Promise<void> | undefined;
  beforeAll(
    () =>
      (setup = (async () => {
        full = await bootFullApp({ name: 'run91c' });
        bff = await seedFlowClient(full);
        userId = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
        await seedConsent(full.conn, {
          userId,
          clientId: bff.clientId,
          resource: FLOW_API_AUD,
          scopes: ['openid', 'api.read'],
        });
      })()),
    INT_SETUP_TIMEOUT_MS,
  );
  afterAll(async () => {
    await settled(setup);
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);

  const session = async () =>
    (await full.app.get(SessionService).create(userId, DEFAULT_TENANT_ID)).id;

  describe('DEBT-662 response_mode', () => {
    const authorize = async (extra: [string, string][], redirectUri = FLOW_REDIRECT) =>
      (await full.app.inject({
        method: 'GET',
        url: `/authorize?${new URLSearchParams([
          ['response_type', 'code'],
          ['client_id', bff.clientId],
          ['redirect_uri', redirectUri],
          ['scope', 'openid api.read'],
          ['resource', FLOW_API_AUD],
          ['state', STATE],
          ['nonce', 'n'],
          ['code_challenge', deriveS256Challenge(randomBytes(32).toString('base64url'))],
          ['code_challenge_method', 'S256'],
          ...extra,
        ]).toString()}`,
        cookies: { [SESSION_COOKIE]: await session() },
      })) as InjectResponse;

    it.each<[string, [string, string][]]>([
      ['form_post', [['response_mode', 'form_post']]],
      ['fragment', [['response_mode', 'fragment']]],
      ['query.jwt', [['response_mode', 'query.jwt']]],
      ['empty', [['response_mode', '']]],
      [
        'repeated',
        [
          ['response_mode', 'query'],
          ['response_mode', 'query'],
        ],
      ],
    ])(
      '%s => 302 invalid_request to the RP (fixed text, state + iss, no code)',
      async (name, extra) => {
        const res = await authorize(extra);
        expect(res.statusCode).toBe(302);
        const loc = new URL(String(res.headers['location']));
        expect(`${loc.origin}${loc.pathname}`).toBe(FLOW_REDIRECT);
        expect(loc.searchParams.get('error')).toBe('invalid_request');
        expect(loc.searchParams.get('error_description')).toBe(
          'Only response_mode=query is supported.',
        );
        expect(loc.searchParams.get('state')).toBe(STATE);
        expect(loc.searchParams.get('iss')).toBe(FULL_APP_ISSUER);
        expect(loc.searchParams.get('code')).toBeNull();
        if (name !== 'empty' && name !== 'repeated') expect(loc.href).not.toContain(name);
      },
    );

    it('response_mode=query => a code as usual', async () => {
      const res = await authorize([['response_mode', 'query']]);
      expect(res.statusCode).toBe(302);
      expect(new URL(String(res.headers['location'])).searchParams.get('code')).toBeTruthy();
    });

    it('untrusted redirect_uri + form_post => first-party 400 page, no Location', async () => {
      const res = await authorize([['response_mode', 'form_post']], 'https://attacker.example/cb');
      expect(res.statusCode).toBe(400);
      expect(res.headers['location']).toBeUndefined();
    });

    it('every /authorize answer is no-store: error page, expired page, 302 with code, 302 with error, 302 to /login (senior lot C)', async () => {
      const page = await authorize([], 'https://attacker.example/cb');
      expect(page.statusCode).toBe(400);
      const expired = (await full.app.inject({
        method: 'GET',
        url: '/authorize?request_id=nope',
      })) as InjectResponse;
      expect(expired.statusCode).toBe(400);
      const code = await authorize([]);
      expect(new URL(String(code.headers['location'])).searchParams.get('code')).toBeTruthy();
      const error = await authorize([['response_mode', 'fragment']]);
      expect(error.statusCode).toBe(302);
      const anon = (await full.app.inject({
        method: 'GET',
        url: `/authorize?${new URLSearchParams({
          response_type: 'code',
          client_id: bff.clientId,
          redirect_uri: FLOW_REDIRECT,
          scope: 'openid api.read',
          resource: FLOW_API_AUD,
          state: STATE,
          code_challenge: deriveS256Challenge(randomBytes(32).toString('base64url')),
          code_challenge_method: 'S256',
        }).toString()}`,
      })) as InjectResponse;
      expect(String(anon.headers['location'])).toMatch(/^\/login\?returnTo=/);
      for (const res of [page, expired, code, error, anon]) {
        expect(res.headers['cache-control']).toBe('no-store');
      }
    });

    it('discovery advertises response_modes_supported = ["query"]', async () => {
      const body = (
        await full.app.inject({ method: 'GET', url: '/.well-known/openid-configuration' })
      ).json<Record<string, unknown>>();
      expect(body.response_modes_supported).toEqual(['query']);
    });
  });

  describe('DEBT-663 no-store on session/CSRF pages (D91.12)', () => {
    const get = async (url: string, sid?: string) =>
      (await full.app.inject({
        method: 'GET',
        url,
        ...(sid ? { cookies: { [SESSION_COOKIE]: sid } } : {}),
      })) as InjectResponse;

    it('GET / with a session => 200 + no-store; without => 302 /login + no-store', async () => {
      const signed = await get('/', await session());
      expect(signed.statusCode).toBe(200);
      expect(signed.headers['cache-control']).toBe('no-store');
      const anon = await get('/');
      expect(anon.statusCode).toBe(302);
      expect(anon.headers['location']).toBe('/login');
      expect(anon.headers['cache-control']).toBe('no-store');
    });

    it.each([
      '/login',
      '/register',
      '/forgot',
      '/verify-email',
      '/reset',
      '/logout',
      '/login/mfa',
      '/account/password',
      '/account/sessions',
      '/account/apps',
      '/account/mfa',
    ])('GET %s (signed in and signed out) => no-store', async (url) => {
      for (const sid of [await session(), undefined]) {
        const res = await get(url, sid);
        expect(res.statusCode).toBeLessThan(500);
        expect(res.headers['cache-control']).toBe('no-store');
      }
    });
  });

  describe('DEBT-667 (d): no TRUST_PROXY => the client x-request-id is never used', () => {
    it('a safe client id is replaced by a fresh UUID, and the audit requestId is the echoed id', async () => {
      const page = await full.app.inject({ method: 'GET', url: '/login' });
      const cookie = String(page.headers['set-cookie'] ?? '')
        .split(/,(?=\s*\w+=)/)
        .map((c) => c.trim())
        .find((c) => c.startsWith('idp_csrf='))!
        .split(';', 1)[0]
        .slice('idp_csrf='.length);
      const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)![1];
      const res = await full.app.inject({
        method: 'POST',
        url: '/login',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-request-id': 'r91c-client-id',
        },
        cookies: { idp_csrf: decodeURIComponent(cookie) },
        payload: new URLSearchParams({
          _csrf: csrf,
          email: `r91c-${randomBytes(4).toString('hex')}@example.com`,
          password: 'wrong password 123',
        }).toString(),
      });
      expect(res.statusCode).toBe(401);
      const echoed = String(res.headers['x-request-id']);
      expect(echoed).not.toBe('r91c-client-id');
      expect(echoed).toMatch(/^[0-9a-f-]{36}$/);
      const audit = await full.conn.model('AuditLog').find({ requestId: echoed }).lean();
      expect(audit.length).toBeGreaterThan(0);
      expect(
        await full.conn.model('AuditLog').countDocuments({ requestId: 'r91c-client-id' }),
      ).toBe(0);
    });
  });
});
