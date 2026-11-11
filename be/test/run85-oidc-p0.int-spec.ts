import { jest } from '@jest/globals';
import IORedis from 'ioredis';
import { randomBytes } from 'node:crypto';
import { deriveS256Challenge } from '../src/common/crypto/pkce.util';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { TokenSigner } from '../src/modules/keys/token-signer';
import { SESSION_COOKIE } from '../src/modules/sessions/session.cookie';
import { SessionService } from '../src/modules/sessions/session.service';
import {
  authorizeCode,
  bootFullApp,
  FLOW_API_AUD,
  FLOW_REDIRECT,
  FULL_APP_ISSUER,
  formPost,
  seedFlowClient,
  type FullApp,
  type InjectResponse,
} from './full-app';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';
import { seedConsent, seedOAuthUser } from './oauth-fixtures';

/**
 * Run 85 T2 (D85.9) on the REAL app:
 * - DEBT-571, OIDC Core §6.1/§6.2: `/authorize` with `request` / `request_uri` is refused with
 *   `request_not_supported` / `request_uri_not_supported` to the TRUSTED redirect_uri (never before
 *   it is trusted, never a context/code); discovery says both are unsupported (the Discovery default
 *   for `request_uri_parameter_supported` is `true`).
 * - DEBT-584, OIDC Core §5.3.1: `POST /userinfo` answers exactly like GET; the token is ONLY read
 *   from the `Authorization: Bearer` header, never from the form body.
 */
const ORIGIN = 'https://spa.run85.example';
const OTHER_ORIGIN = 'https://evil.run85.example';
const STATE = 'rp-state-r85';

describe('run 85 T2: request/request_uri refused, POST /userinfo (real app)', () => {
  let full: FullApp;
  let bff: { clientId: string; secret: string };
  let redis: IORedis;
  let userId = '';
  let sessionId = '';

  const boot = async (): Promise<void> => {
    full = await bootFullApp({ name: 'run85-oidc' });
    redis = new IORedis(full.env.REDIS_URL, { maxRetriesPerRequest: 1 });
    bff = await seedFlowClient(full);
    await full.conn
      .model('Client')
      .updateOne({ clientId: bff.clientId }, { $set: { allowedCorsOrigins: [ORIGIN] } });
    userId = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
    await seedConsent(full.conn, {
      userId,
      clientId: bff.clientId,
      resource: FLOW_API_AUD,
      scopes: ['openid', 'email', 'api.read'],
    });
    sessionId = (await full.app.get(SessionService).create(userId, DEFAULT_TENANT_ID)).id;
  };
  let setup: Promise<void> | undefined;
  beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await settled(setup);
    redis?.disconnect();
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);
  afterEach(() => jest.restoreAllMocks());

  // ------------------------------------------------------------------ DEBT-571

  const authorize = (extra: [string, string][], redirectUri = FLOW_REDIRECT) =>
    full.app.inject({
      method: 'GET',
      url: `/authorize?${new URLSearchParams([
        ['response_type', 'code'],
        ['client_id', bff.clientId],
        ['redirect_uri', redirectUri],
        ['scope', 'openid api.read'],
        ['resource', FLOW_API_AUD],
        ['state', STATE],
        ['nonce', 'rp-nonce-r85'],
        ['code_challenge', deriveS256Challenge(randomBytes(32).toString('base64url'))],
        ['code_challenge_method', 'S256'],
        ...extra,
      ]).toString()}`,
      cookies: { [SESSION_COOKIE]: sessionId },
    }) as Promise<InjectResponse>;

  const flowKeys = async () =>
    (await redis.keys('authz_code:*')).length + (await redis.keys('authz_ctx:*')).length;

  /** 302 to the trusted redirect_uri with `error`, the original state and iss; no code. */
  const expectRedirectError = (res: InjectResponse, error: string) => {
    expect(res.statusCode).toBe(302);
    const loc = new URL(String(res.headers['location']));
    expect(`${loc.origin}${loc.pathname}`).toBe(FLOW_REDIRECT);
    expect(loc.searchParams.get('error')).toBe(error);
    expect(loc.searchParams.get('state')).toBe(STATE);
    expect(loc.searchParams.get('iss')).toBe(FULL_APP_ISSUER);
    expect(loc.searchParams.get('code')).toBeNull();
  };

  it('control: the same request without request/request_uri issues a code', async () => {
    const res = await authorize([]);
    expect(res.statusCode).toBe(302);
    expect(new URL(String(res.headers['location'])).searchParams.get('code')).toBeTruthy();
  });

  it.each<[string, [string, string][], string]>([
    // (1) an unsigned request object
    ['request', [['request', 'eyJhbGciOiJub25lIn0.e30.']], 'request_not_supported'],
    // (2) never fetched (no SSRF)
    ['request_uri', [['request_uri', 'https://rp.example/r']], 'request_uri_not_supported'],
    // (3) both: request wins
    [
      'request + request_uri',
      [
        ['request_uri', 'https://rp.example/r'],
        ['request', 'eyJhbGciOiJub25lIn0.e30.'],
      ],
      'request_not_supported',
    ],
    // (4) empty / repeated: still the same error, never a 500
    ['empty request', [['request', '']], 'request_not_supported'],
    [
      'repeated request',
      [
        ['request', 'a'],
        ['request', 'b'],
      ],
      'request_not_supported',
    ],
    ['empty request_uri', [['request_uri', '']], 'request_uri_not_supported'],
    [
      'repeated request_uri',
      [
        ['request_uri', 'https://rp.example/a'],
        ['request_uri', 'https://rp.example/b'],
      ],
      'request_uri_not_supported',
    ],
  ])('(1-4) %s %j => %s to the RP, no context, no code', async (_name, extra, error) => {
    const before = await flowKeys();
    expectRedirectError(await authorize(extra), error);
    expect(await flowKeys()).toBe(before);
  });

  it('(5) unregistered redirect_uri + request => first-party 400 page, never a redirect', async () => {
    const res = await authorize(
      [['request', 'eyJhbGciOiJub25lIn0.e30.']],
      'https://attacker.example/cb',
    );
    expect(res.statusCode).toBe(400);
    expect(res.headers['location']).toBeUndefined();
    expect(res.body).not.toContain('request_not_supported');
  });

  it('(6) discovery advertises request and request_uri as unsupported', async () => {
    const body = (
      await full.app.inject({ method: 'GET', url: '/.well-known/openid-configuration' })
    ).json<Record<string, unknown>>();
    expect(body.request_parameter_supported).toBe(false);
    expect(body.request_uri_parameter_supported).toBe(false);
  });

  // ------------------------------------------------------------------ DEBT-584

  /** Real code flow: AT (aud api, scope openid email api.read, sid of `sid`) + ID token. */
  const tokens = async (sid = sessionId) => {
    const verifier = randomBytes(32).toString('base64url');
    const code = await authorizeCode(full, {
      clientId: bff.clientId,
      sessionId: sid,
      resource: FLOW_API_AUD,
      scope: 'openid email api.read',
      verifier,
    });
    const res = await formPost(full, '/token', bff, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: FLOW_REDIRECT,
      code_verifier: verifier,
      resource: FLOW_API_AUD,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ access_token: string; id_token: string }>();
    return { at: body.access_token, idToken: body.id_token };
  };

  const userinfo = (
    method: 'GET' | 'POST',
    opts: { token?: string; origin?: string; form?: Record<string, string> } = {},
  ) =>
    full.app.inject({
      method,
      url: '/userinfo',
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.origin ? { origin: opts.origin } : {}),
        ...(opts.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(opts.form ? { payload: new URLSearchParams(opts.form).toString() } : {}),
    }) as Promise<InjectResponse>;

  const expect401 = (res: InjectResponse) => {
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_token' });
    expect(res.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
    expect(res.headers['cache-control']).toBe('no-store');
  };

  it('(7) POST with a valid Bearer header => 200, body identical to GET, no-store', async () => {
    const { at } = await tokens();
    const get = await userinfo('GET', { token: at });
    const post = await userinfo('POST', { token: at });
    expect(get.statusCode).toBe(200);
    expect(post.statusCode).toBe(200);
    expect(post.json()).toEqual(get.json());
    expect(post.json()).toMatchObject({ sub: userId, email_verified: true });
    expect(post.headers['cache-control']).toBe('no-store');
  });

  it('(7b) POST with a form body AND a Bearer header => the body is ignored (200 as GET)', async () => {
    const { at } = await tokens();
    const post = await userinfo('POST', { token: at, form: { access_token: 'garbage' } });
    expect(post.statusCode).toBe(200);
    expect(post.json()).toEqual((await userinfo('GET', { token: at })).json());
  });

  it('(8) POST with the access token only in the form body => 401 invalid_token', async () => {
    const { at } = await tokens();
    expect401(await userinfo('POST', { form: { access_token: at } }));
    expect401(await userinfo('POST'));
  });

  it('(9) POST: ID token => 401; no openid scope => 403; logged-out sid => 401', async () => {
    const { idToken } = await tokens();
    expect401(await userinfo('POST', { token: idToken }));

    const noOpenid = await full.app.get(TokenSigner).sign(
      {
        scope: 'api.read',
        client_id: bff.clientId,
        sid: randomBytes(32).toString('hex'),
        auth_time: Math.floor(Date.now() / 1000),
      },
      { audience: FLOW_API_AUD, subject: userId, expiresInSec: 900, typ: 'at+jwt' },
    );
    const forbidden = await userinfo('POST', { token: noOpenid });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({ error: 'insufficient_scope' });
    expect(forbidden.headers['www-authenticate']).toBe('Bearer error="insufficient_scope"');

    const ended = (await full.app.get(SessionService).create(userId, DEFAULT_TENANT_ID)).id;
    const { at } = await tokens(ended);
    expect((await userinfo('POST', { token: at })).statusCode).toBe(200);
    await full.app.get(SessionService).revoke(ended);
    expect401(await userinfo('POST', { token: at }));
  });

  it("(10) POST from the token client's registered Origin => ACAO; another Origin => none", async () => {
    const { at } = await tokens();
    const ok = await userinfo('POST', { token: at, origin: ORIGIN });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
    const other = await userinfo('POST', { token: at, origin: OTHER_ORIGIN });
    expect(other.statusCode).toBe(200);
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});
