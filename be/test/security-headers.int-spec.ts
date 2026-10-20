import { jest } from '@jest/globals';
import { Types } from 'mongoose';
import { randomBytes } from 'node:crypto';
import { buildCsp } from '../src/common/http/csp';
import { ClientAuthenticationService } from '../src/modules/clients/client-authentication.service';
import { ClientService } from '../src/modules/clients/client.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { SessionService } from '../src/modules/sessions/session.service';
import {
  authorizeCode,
  bootFullApp,
  FLOW_ADMIN_AUD,
  FLOW_API_AUD,
  formPost,
  seedFlowClient,
  type FullApp,
  type InjectResponse,
} from './full-app';
import { seedConsent, seedOAuthUser } from './oauth-fixtures';

/**
 * Security headers per response type (B7.4 Task 3) on the REAL `configureApp` (helmet + routes).
 * Every type: nosniff, Referrer-Policy, frame protection, HSTS (unconditional, >= 180 days), CSP
 * without unsafe-inline/eval (=== `buildCsp()` unless the route relaxes only form-action/frame-src),
 * no X-Powered-By / version banner. `no-store` on every sensitive type; discovery, JWKS and static
 * assets stay cacheable (never forced to no-store).
 */
const METRICS_TOKEN = randomBytes(32).toString('hex');

type Cache = 'no-store' | 'cacheable';
interface Row {
  name: string;
  status: number;
  cache: Cache;
  send: () => Promise<InjectResponse>;
}

describe('security headers by response type (B7.4)', () => {
  let full: FullApp;
  let client: { clientId: string; secret: string };
  let sessionId = '';
  let accessToken = '';
  let refreshToken = '';
  let adminToken = '';

  const get = (url: string, headers: Record<string, string> = {}) =>
    full.app.inject({ method: 'GET', url, headers });
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  async function tokens(resource: string, scope: string) {
    const verifier = randomBytes(32).toString('base64url');
    const code = await authorizeCode(full, { ...client, sessionId, resource, scope, verifier });
    const res = await formPost(full, '/token', client, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://app.example.com/callback',
      code_verifier: verifier,
    });
    return res;
  }

  beforeAll(async () => {
    full = await bootFullApp({ name: 'headers', env: { METRICS_TOKEN } });
    client = await seedFlowClient(full);
    const userId = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
    await full.conn
      .model('UserTenant')
      .updateOne(
        { userId: new Types.ObjectId(userId), tenantId: DEFAULT_TENANT_ID },
        { $set: { roles: ['tenant_admin'] } },
      );
    for (const [resource, scopes] of [
      [FLOW_API_AUD, ['openid', 'offline_access', 'api.read']],
      [FLOW_ADMIN_AUD, ['openid', 'admin.read']],
    ] as const) {
      await seedConsent(full.conn, {
        userId,
        clientId: client.clientId,
        resource,
        scopes: [...scopes],
      });
    }
    sessionId = (await full.app.get(SessionService).create(userId, DEFAULT_TENANT_ID)).id;
    const api = (await tokens(FLOW_API_AUD, 'openid offline_access api.read')).json<{
      access_token: string;
      refresh_token: string;
    }>();
    accessToken = api.access_token;
    refreshToken = api.refresh_token;
    adminToken = (await tokens(FLOW_ADMIN_AUD, 'openid admin.read')).json<{
      access_token: string;
    }>().access_token;
  }, 60_000);

  afterAll(async () => {
    if (full) await full.close();
  });

  afterEach(() => jest.restoreAllMocks());

  const rows: Row[] = [
    { name: 'UI HTML GET /login', status: 200, cache: 'no-store', send: () => get('/login') },
    { name: 'UI HTML GET /register', status: 200, cache: 'no-store', send: () => get('/register') },
    { name: 'UI HTML GET /forgot', status: 200, cache: 'no-store', send: () => get('/forgot') },
    {
      name: 'JSON OAuth POST /token 200',
      status: 200,
      cache: 'no-store',
      send: () => tokens(FLOW_API_AUD, 'openid api.read'),
    },
    {
      name: 'JSON OAuth POST /token 400 invalid_request',
      status: 400,
      cache: 'no-store',
      send: () =>
        full.app.inject({
          method: 'POST',
          url: '/token',
          headers: { 'content-type': 'application/json' },
          payload: '{}',
        }),
    },
    {
      name: 'JSON OAuth POST /token 500',
      status: 500,
      cache: 'no-store',
      send: () => {
        jest
          .spyOn(full.app.get(ClientAuthenticationService), 'authenticate')
          .mockRejectedValueOnce(new Error('forced failure'));
        return formPost(full, '/token', client, {
          grant_type: 'refresh_token',
          refresh_token: 'x',
        });
      },
    },
    {
      name: 'JSON OAuth POST /introspect 200',
      status: 200,
      cache: 'no-store',
      send: () => formPost(full, '/introspect', client, { token: accessToken }),
    },
    {
      name: 'JSON OAuth POST /revoke 200',
      status: 200,
      cache: 'no-store',
      send: () => formPost(full, '/revoke', client, { token: refreshToken }),
    },
    {
      name: 'JSON GET /userinfo 200',
      status: 200,
      cache: 'no-store',
      send: () => get('/userinfo', bearer(accessToken)),
    },
    {
      name: 'JSON GET /userinfo 401',
      status: 401,
      cache: 'no-store',
      send: () => get('/userinfo'),
    },
    {
      name: 'discovery',
      status: 200,
      cache: 'cacheable',
      send: () => get('/.well-known/openid-configuration'),
    },
    { name: 'JWKS', status: 200, cache: 'cacheable', send: () => get('/jwks.json') },
    {
      name: 'static asset',
      status: 200,
      cache: 'cacheable',
      send: () => get('/assets/styles.css'),
    },
    {
      name: 'admin GET /admin/clients 200',
      status: 200,
      cache: 'no-store',
      send: () => get('/admin/clients', bearer(adminToken)),
    },
    {
      name: 'admin GET /admin/clients 401',
      status: 401,
      cache: 'no-store',
      send: () => get('/admin/clients'),
    },
    {
      name: 'admin GET /admin/clients 500',
      status: 500,
      cache: 'no-store',
      send: () => {
        jest
          .spyOn(full.app.get(ClientService), 'listForTenant')
          .mockRejectedValueOnce(new Error('forced failure'));
        return get('/admin/clients', bearer(adminToken));
      },
    },
    {
      name: 'GET /metrics 200',
      status: 200,
      cache: 'no-store',
      send: () => get('/metrics', bearer(METRICS_TOKEN)),
    },
    {
      name: 'GET /metrics 401',
      status: 401,
      cache: 'no-store',
      send: () => get('/metrics', bearer('wrong')),
    },
    {
      name: '404 unknown route',
      status: 404,
      cache: 'no-store',
      send: () => get('/no-such-route'),
    },
  ];

  describe.each(rows)('$name', ({ status, cache, send }) => {
    let res: InjectResponse;
    beforeAll(async () => {
      res = await send();
    });
    const h = (name: string) => res.headers[name];

    it(`status ${status}`, () => {
      expect(res.statusCode).toBe(status);
    });

    it('nosniff, Referrer-Policy, frame protection', () => {
      expect(h('x-content-type-options')).toBe('nosniff');
      expect(h('referrer-policy')).toBe('no-referrer');
      expect(h('x-frame-options') ?? '').toMatch(/^(DENY|SAMEORIGIN)$/);
    });

    it('HSTS max-age >= 180 days on every response', () => {
      const m = /max-age=(\d+)/.exec(String(h('strict-transport-security') ?? ''));
      expect(Number(m?.[1] ?? 0)).toBeGreaterThanOrEqual(15552000);
    });

    it("CSP === buildCsp() (frame-ancestors 'none', form-action 'self', no unsafe-*)", () => {
      const csp = String(h('content-security-policy') ?? '');
      expect(csp).toBe(buildCsp());
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("form-action 'self'");
      expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    });

    it('no X-Powered-By, no versioned Server banner', () => {
      expect(h('x-powered-by')).toBeUndefined();
      expect(String(h('server') ?? '')).not.toMatch(/\d/);
    });

    it(`Cache-Control: ${cache}`, () => {
      const cc = String(h('cache-control') ?? '');
      if (cache === 'no-store') expect(cc).toMatch(/\bno-store\b/);
      else expect(cc).not.toMatch(/\bno-store\b/);
    });
  });
});
