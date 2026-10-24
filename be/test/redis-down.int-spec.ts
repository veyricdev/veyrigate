import { jest } from '@jest/globals';
import { randomBytes, randomUUID } from 'node:crypto';
import { hashPassword } from '../src/common/crypto/crypto.util';
import { OAuthExceptionFilter } from '../src/common/filters/oauth-exception.filter';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { KEY_PROVIDER, type KeyProvider } from '../src/modules/keys/key-provider';
import { UserService } from '../src/modules/identity/user.service';
import { UserTenantService } from '../src/modules/identity/user-tenant.service';
import { IntrospectController } from '../src/modules/oauth/introspect/introspect.controller';
import { TokenController } from '../src/modules/oauth/token/token.controller';
import { SESSION_COOKIE } from '../src/modules/sessions/session.cookie';
import { SessionService } from '../src/modules/sessions/session.service';
import { ANON_COOKIE, CsrfService } from '../src/modules/ui/csrf.service';
import { HtmlExceptionFilter } from '../src/modules/ui/html-exception.filter';
import { deriveS256Challenge } from '../src/common/crypto/pkce.util';
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
import { seedConsent } from './oauth-fixtures';
import { startRedisProxy, type RedisProxy } from './redis-proxy';

/**
 * Run 53c (B7.3, plan §6.2): "kill Redis ⇒ endpoints that need state answer a clear error, never a
 * silent wrong answer". The REAL app talks to `vg-test-redis` through an in-process TCP proxy; the
 * proxy (never the shared container) is taken down — `refuse` (connection refused) and `blackhole`
 * (accepted, never answered). Every Redis-dependent endpoint must answer 503
 * `temporarily_unavailable` + `Retry-After: 5` + `no-store`, set no session cookie and carry no
 * token; `/introspect` never says `active` (ma trận #28: infra error ⇒ 5xx, never active:true/false);
 * `/health` stays 200, `/ready` 503. After the proxy is back the same session/code/RT work again (no
 * state was consumed by the failed requests). Every error that reached a filter is recorded: the
 * table in runs/53c-B7.3/log.md was built from this record.
 */
const SCOPE = 'openid offline_access api.read';
const PASSWORD = 'redis-down-password-1'; // throwaway int DB user
const TOKEN_LEAK = /eyJ|access_token|refresh_token|id_token/;

type Auth = { clientId: string; secret: string };

describe('Redis down ⇒ 503 temporarily_unavailable, fail-closed, recovers (run 53c)', () => {
  let proxy: RedisProxy;
  let full: FullApp;
  let client: Auth;
  let userId = '';
  let email = '';
  let sessionId = '';
  let csrf: CsrfService;
  const seen: string[] = [];
  /** `<endpoint>: <errors that reached a renderer>` per mode — the observed-error table (log.md). */
  const table: string[] = [];
  let seenUpTo = 0;

  beforeAll(async () => {
    // Record what reaches each error renderer (class | name | message), without changing behaviour.
    const record = (err: unknown) =>
      seen.push(
        err instanceof Error
          ? `${err.constructor.name} | ${err.name} | ${err.message.slice(0, 80)}`
          : `non-Error ${typeof err}`,
      );
    for (const proto of [OAuthExceptionFilter.prototype, HtmlExceptionFilter.prototype]) {
      const original = proto.catch;
      jest.spyOn(proto, 'catch').mockImplementation(function (this: unknown, e, host) {
        record(e);
        return original.call(this, e, host);
      });
    }
    for (const proto of [
      TokenController.prototype,
      IntrospectController.prototype,
    ] as unknown as Array<Record<string, (...a: unknown[]) => unknown>>) {
      const original = proto.renderError;
      jest.spyOn(proto, 'renderError').mockImplementation(function (this: unknown, ...a) {
        record(a[a.length - 1]);
        return original.apply(this, a);
      });
    }
    // (installed before boot: Nest binds the filter methods when it registers them)
    proxy = await startRedisProxy();
    full = await bootFullApp({ name: 'redis-down', env: { REDIS_URL: proxy.url } });
    client = await seedFlowClient(full);
    email = `redis-down-${randomUUID()}@fixture.test`;
    const users = full.app.get(UserService);
    const user = await users.createWithPasswordHash(email, await hashPassword(PASSWORD));
    await users.verifyEmail(user.sub);
    await full.app.get(UserTenantService).addMembership(user.sub, DEFAULT_TENANT_ID);
    userId = user.sub;
    await seedConsent(full.conn, {
      userId,
      clientId: client.clientId,
      resource: FLOW_API_AUD,
      scopes: SCOPE.split(' '),
    });
    sessionId = (await full.app.get(SessionService).create(userId, DEFAULT_TENANT_ID)).id;
    csrf = full.app.get(CsrfService);
  }, 90_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    console.log(`run 53c — errors seen by the renderers:\n${table.join('\n')}`);
    await proxy?.up();
    if (full) await full.close();
    await proxy?.close();
  });

  /** A fresh code + verifier while Redis is up. */
  async function mintCode(): Promise<{ code: string; verifier: string }> {
    const verifier = randomBytes(32).toString('base64url');
    const code = await authorizeCode(full, {
      ...client,
      sessionId,
      resource: FLOW_API_AUD,
      scope: SCOPE,
      verifier,
    });
    return { code, verifier };
  }
  const exchange = (code: string, verifier: string) =>
    formPost(full, '/token', client, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: FLOW_REDIRECT,
      code_verifier: verifier,
    });
  const userinfo = (at: string) =>
    full.app.inject({
      method: 'GET',
      url: '/userinfo',
      headers: { authorization: `Bearer ${at}` },
    });
  const form = (url: string, cookies: Record<string, string>, fields: Record<string, string>) =>
    full.app.inject({
      method: 'POST',
      url,
      cookies,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(fields).toString(),
    });
  const authorizeUrl = () =>
    `/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: FLOW_REDIRECT,
      scope: SCOPE,
      resource: FLOW_API_AUD,
      state: 's',
      nonce: 'n',
      code_challenge: deriveS256Challenge(randomBytes(32).toString('base64url')),
      code_challenge_method: 'S256',
    }).toString()}`;

  /**
   * The contract of every Redis-dependent endpoint while Redis is down. Collected (not thrown) so one
   * run reports every endpoint; the test asserts the list is empty.
   */
  function checkUnavailable(
    failures: string[],
    name: string,
    res: InjectResponse,
    kind: 'json' | 'html',
  ): void {
    const problems: string[] = [];
    if (res.statusCode !== 503) problems.push(`status ${res.statusCode}`);
    if (res.headers['retry-after'] !== '5')
      problems.push(`retry-after ${res.headers['retry-after']}`);
    if (!String(res.headers['cache-control']).includes('no-store')) problems.push('no no-store');
    if (String(res.headers['set-cookie'] ?? '').includes(SESSION_COOKIE))
      problems.push('session cookie');
    if (TOKEN_LEAK.test(res.body)) problems.push('token in body');
    if (kind === 'json') {
      const body = res.json();
      if (body.error !== 'temporarily_unavailable') problems.push(`error ${String(body.error)}`);
      if ('active' in body) problems.push('active present');
    } else if (!String(res.headers['content-type']).includes('text/html')) {
      problems.push('not html');
    }
    table.push(`${name}: ${[...new Set(seen.slice(seenUpTo))].join(' ; ') || '-'}`);
    seenUpTo = seen.length;
    if (problems.length) failures.push(`${name}: ${problems.join(', ')}`);
  }

  async function waitReady(): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if ((await full.app.inject({ method: 'GET', url: '/ready' })).statusCode === 200) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('app did not become ready again');
  }

  // A failed run must not leave Redis down for the next case.
  afterEach(async () => {
    await proxy.up();
    await waitReady();
  });

  it.each(['refuse', 'blackhole'] as const)(
    'Redis %s: every state endpoint ⇒ 503, no session cookie, no token; then recovers',
    async (mode) => {
      // State created while Redis is up: a code, an AT (with sid) and an RT.
      const first = await mintCode();
      const issued = await exchange(first.code, first.verifier);
      expect(issued.statusCode).toBe(200);
      const { access_token: at, refresh_token: rt } = issued.json<{
        access_token: string;
        refresh_token: string;
      }>();
      const pending = await mintCode(); // exchanged only after recovery

      if (mode === 'refuse') await proxy.refuse();
      else proxy.blackhole();

      const failures: string[] = [];
      const expectUnavailable = (name: string, res: InjectResponse, kind: 'json' | 'html') =>
        checkUnavailable(failures, name, res, kind);
      seenUpTo = seen.length;
      table.push(`--- ${mode}`);
      const session = { [SESSION_COOKIE]: sessionId };
      const anon = randomBytes(16).toString('hex');
      expectUnavailable(
        'GET /authorize (session)',
        await full.app.inject({ method: 'GET', url: authorizeUrl(), cookies: session }),
        'html',
      );
      expectUnavailable(
        'GET /authorize (anonymous)',
        await full.app.inject({ method: 'GET', url: authorizeUrl() }),
        'html',
      );
      expectUnavailable(
        'POST /login',
        await form(
          '/login',
          { [ANON_COOKIE]: anon },
          {
            _csrf: csrf.token(anon),
            email,
            password: PASSWORD,
          },
        ),
        'html',
      );
      expectUnavailable(
        'POST /authorize/consent',
        await form('/authorize/consent', session, {
          _csrf: csrf.token(sessionId),
          request_id: randomBytes(32).toString('base64url'),
          approve: 'yes',
        }),
        'html',
      );
      expectUnavailable(
        'POST /token (code)',
        await exchange(pending.code, pending.verifier),
        'json',
      );
      expectUnavailable(
        'POST /token (refresh)',
        await formPost(full, '/token', client, { grant_type: 'refresh_token', refresh_token: rt }),
        'json',
      );
      expectUnavailable('GET /userinfo', await userinfo(at), 'json');
      expectUnavailable(
        'POST /introspect',
        await formPost(full, '/introspect', client, { token: at }),
        'json',
      );
      expectUnavailable(
        'POST /logout',
        await form('/logout', session, { _csrf: csrf.token(sessionId) }),
        'html',
      );
      expect(failures).toEqual([]);
      expect((await full.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      const ready = await full.app.inject({ method: 'GET', url: '/ready' });
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toMatchObject({ redis: 'down' });

      // Back up: nothing was consumed or revoked by the failed requests.
      await proxy.up();
      await waitReady();
      expect((await userinfo(at)).statusCode).toBe(200);
      const late = await exchange(pending.code, pending.verifier);
      expect(late.statusCode).toBe(200);
      const refreshed = await formPost(full, '/token', client, {
        grant_type: 'refresh_token',
        refresh_token: rt,
      });
      expect(refreshed.statusCode).toBe(200); // not rotated while down ⇒ no reuse detection
      const introspected = await formPost(full, '/introspect', client, { token: at });
      expect(introspected.json()).toMatchObject({ active: true });
      const resumed = await full.app.inject({
        method: 'GET',
        url: authorizeUrl(),
        cookies: { [SESSION_COOKIE]: sessionId },
      });
      expect(resumed.statusCode).toBe(302); // the session survived the outage
    },
    60_000,
  );

  it('DEBT-394: key provider down ⇒ /userinfo, /introspect, admin API, /demo 503 — never 401 / active:false', async () => {
    const { code, verifier } = await mintCode();
    const issued = await exchange(code, verifier);
    expect(issued.statusCode).toBe(200);
    const at = issued.json<{ access_token: string }>().access_token;
    const keys = full.app.get<KeyProvider>(KEY_PROVIDER);
    const spy = jest
      .spyOn(keys, 'getPublicKeys')
      .mockRejectedValue(new Error('vault read failed: status=503'));
    try {
      const failures: string[] = [];
      const bearer = { authorization: `Bearer ${at}` };
      checkUnavailable(failures, 'GET /userinfo', await userinfo(at), 'json');
      checkUnavailable(
        failures,
        'POST /introspect',
        await formPost(full, '/introspect', client, { token: at }),
        'json',
      );
      checkUnavailable(
        failures,
        'GET /admin/tenants',
        await full.app.inject({ method: 'GET', url: '/admin/tenants', headers: bearer }),
        'json',
      );
      checkUnavailable(
        failures,
        'GET /demo/me',
        await full.app.inject({ method: 'GET', url: '/demo/me', headers: bearer }),
        'json',
      );
      expect(failures).toEqual([]);
      // A malformed token is still judged without the provider: 401 / inactive, not 503.
      expect((await userinfo('not-a-jwt')).statusCode).toBe(401);
    } finally {
      spy.mockRestore();
    }
    expect((await userinfo(at)).statusCode).toBe(200); // provider back ⇒ recovers
  });
});
