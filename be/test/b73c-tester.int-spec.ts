import { jest } from '@jest/globals';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import { hashPassword } from '../src/common/crypto/crypto.util';
import { deriveS256Challenge } from '../src/common/crypto/pkce.util';
import { validateEnv } from '../src/config/validation.schema';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { UserService } from '../src/modules/identity/user.service';
import { UserTenantService } from '../src/modules/identity/user-tenant.service';
import { KEY_PROVIDER, type KeyProvider } from '../src/modules/keys/key-provider';
import { RateLimitService } from '../src/modules/security/rate-limit/rate-limit.service';
import { SESSION_COOKIE } from '../src/modules/sessions/session.cookie';
import { SessionService } from '../src/modules/sessions/session.service';
import { ANON_COOKIE, CsrfService } from '../src/modules/ui/csrf.service';
import {
  authorizeCode,
  bootFullApp,
  FLOW_ADMIN_AUD,
  FLOW_API_AUD,
  FLOW_REDIRECT,
  FULL_APP_ISSUER,
  formPost,
  seedFlowClient,
  type FullApp,
  type InjectResponse,
} from './full-app';
import { seedConsent } from './oauth-fixtures';
import { startRedisProxy, type RedisProxy } from './redis-proxy';

/**
 * Tester risk tests, run 53c (B7.3 part 3: Redis-down 503 + DEBT-394/397). Complements
 * `redis-down.int-spec.ts` (dev) with what it does not cover:
 * - R1: the REST of the Redis-dependent surface (home, register/forgot/reset, /revoke, admin API
 *   with a real admin token incl. a @RequireRecentAuth write, the
 *   step-up `/authorize?prompt=login&max_age=0`) in refuse AND blackhole: 503 + Retry-After 5 +
 *   no-store + NO Set-Cookie at all + no token; Redis-free endpoints stay 200.
 * - R2: refresh while Redis is down (concurrent, both modes) never rotates / burns the family: no
 *   TOKEN_REUSE_DETECTED, exactly one active token per family after recovery, the chain continues.
 * - R3: Redis failing AFTER the code was consumed (partial failure) ⇒ 503, no token, no family
 *   left alive; the retry is invalid_grant (DEBT-404 is the doc side of this).
 * - R4: Redis dying after the client-auth reservation (refund fails) ⇒ refresh still 200, single
 *   rotation (best-effort refund, not a silent wrong answer).
 * - V1–V3 (key provider down, DEBT-394): admin API 503 with a real admin token; malformed token
 *   still 401 / active:false / admin 401; a forged token with an unknown kid ⇒ 503 (never 200);
 *   logout with a valid id_token_hint + REGISTERED or hostile post_logout_redirect_uri ⇒ default
 *   redirect only (no open redirect), session ended, cookie cleared.
 * - S1: app.close() with Redis down (refuse + blackhole) returns < 10 s and no reconnect follows
 *   (DEBT-397, in-process; the Docker exit code is smoke check 8).
 * - C1: Sentinel config: both / neither refused; canary values never echoed.
 */
const SCOPE = 'openid offline_access api.read';
const ADMIN_SCOPE = 'openid admin.read admin.write';
const PASSWORD = 'b73c-tester-password-1'; // throwaway int DB user
const TOKEN_LEAK = /eyJ|access_token|refresh_token|id_token/;
const POST_LOGOUT = 'https://app.example.com/after-logout';

type Auth = { clientId: string; secret: string };

describe('run 53c tester: Redis / key provider down — wider surface, families, logout', () => {
  let proxy: RedisProxy;
  let full: FullApp;
  let client: Auth;
  let userId = '';
  let email = '';
  let csrf: CsrfService;

  beforeAll(async () => {
    proxy = await startRedisProxy();
    full = await bootFullApp({ name: 'b73c-tester', env: { REDIS_URL: proxy.url } });
    client = await seedFlowClient(full);
    await full.conn
      .model('Client')
      .updateOne(
        { clientId: client.clientId },
        { $set: { postLogoutRedirectUris: [POST_LOGOUT] } },
      );
    email = `b73c-${randomUUID()}@fixture.test`;
    const users = full.app.get(UserService);
    const user = await users.createWithPasswordHash(email, await hashPassword(PASSWORD));
    await users.verifyEmail(user.sub);
    await full.app
      .get(UserTenantService)
      .addMembership(user.sub, DEFAULT_TENANT_ID, ['tenant_admin']);
    userId = user.sub;
    await seedConsent(full.conn, {
      userId,
      clientId: client.clientId,
      resource: FLOW_API_AUD,
      scopes: SCOPE.split(' '),
    });
    await seedConsent(full.conn, {
      userId,
      clientId: client.clientId,
      resource: FLOW_ADMIN_AUD,
      scopes: ADMIN_SCOPE.split(' '),
    });
    csrf = full.app.get(CsrfService);
  }, 90_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await proxy?.up();
    if (full) await full.close();
    await proxy?.close();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await proxy.up();
    await waitReady();
  });

  async function waitReady(): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if ((await full.app.inject({ method: 'GET', url: '/ready' })).statusCode === 200) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('app did not become ready again');
  }

  const newSession = async () =>
    (await full.app.get(SessionService).create(userId, DEFAULT_TENANT_ID)).id;

  /** Code flow while Redis is up ⇒ tokens. */
  async function issue(
    sessionId: string,
    resource = FLOW_API_AUD,
    scope = SCOPE,
  ): Promise<{ access_token: string; refresh_token?: string; id_token?: string }> {
    const verifier = randomBytes(32).toString('base64url');
    const code = await authorizeCode(full, { ...client, sessionId, resource, scope, verifier });
    const res = await formPost(full, '/token', client, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: FLOW_REDIRECT,
      code_verifier: verifier,
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  const form = (
    url: string,
    cookies: Record<string, string>,
    fields: Record<string, string>,
  ): Promise<InjectResponse> =>
    full.app.inject({
      method: 'POST',
      url,
      cookies,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(fields).toString(),
    });

  const refresh = (rt: string) =>
    formPost(full, '/token', client, { grant_type: 'refresh_token', refresh_token: rt });

  const authorizeUrl = (extra: Record<string, string> = {}) =>
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
      ...extra,
    }).toString()}`;

  /** The strict outage contract (stricter than the dev test: NO Set-Cookie of any kind). */
  function contract(name: string, res: InjectResponse, kind: 'json' | 'html' | 'any'): string[] {
    const p: string[] = [];
    if (res.statusCode !== 503) p.push(`status ${res.statusCode}`);
    if (res.headers['retry-after'] !== '5') p.push(`retry-after ${res.headers['retry-after']}`);
    if (!String(res.headers['cache-control']).includes('no-store')) p.push('no no-store');
    if (res.headers['set-cookie'] !== undefined)
      p.push(`set-cookie ${String(res.headers['set-cookie']).split('=')[0]}`);
    if (res.headers['location'] !== undefined) p.push('redirect');
    if (TOKEN_LEAK.test(res.body)) p.push('token in body');
    if (kind === 'json') {
      const body = res.json();
      if (body.error !== 'temporarily_unavailable') p.push(`error ${String(body.error)}`);
      if ('active' in body) p.push('active present');
    }
    if (kind === 'html' && !String(res.headers['content-type']).includes('text/html'))
      p.push('not html');
    return p.length ? [`${name}: ${p.join(', ')}`] : [];
  }

  it.each(['refuse', 'blackhole'] as const)(
    'R1 Redis %s: rest of the state surface (incl. admin + step-up) ⇒ strict 503; Redis-free endpoints 200',
    async (mode) => {
      const sessionId = await newSession();
      const admin = await issue(sessionId, FLOW_ADMIN_AUD, ADMIN_SCOPE);
      const api = await issue(sessionId);
      const session = { [SESSION_COOKIE]: sessionId };
      const anon = randomBytes(16).toString('hex');
      const anonCookie = { [ANON_COOKIE]: anon };
      const adminBearer = { authorization: `Bearer ${admin.access_token}` };
      // Sanity while up: the admin token works.
      expect(
        (await full.app.inject({ method: 'GET', url: '/admin/tenants', headers: adminBearer }))
          .statusCode,
      ).toBe(200);

      if (mode === 'refuse') await proxy.refuse();
      else proxy.blackhole();

      const f: string[] = [];
      f.push(
        ...contract(
          'GET / (session)',
          await full.app.inject({ method: 'GET', url: '/', cookies: session }),
          'html',
        ),
      );
      f.push(
        ...contract(
          'GET /authorize prompt=login max_age=0 (step-up)',
          await full.app.inject({
            method: 'GET',
            url: authorizeUrl({ prompt: 'login', max_age: '0' }),
            cookies: session,
          }),
          'html',
        ),
      );
      for (const [url, fields] of [
        ['/register', { email: `x-${randomUUID()}@fixture.test`, password: PASSWORD }],
        ['/forgot', { email }],
        ['/reset', { token: randomBytes(32).toString('base64url'), password: PASSWORD }],
      ] as const) {
        f.push(
          ...contract(
            `POST ${url}`,
            await form(url, anonCookie, { _csrf: csrf.token(anon), ...fields }),
            'html',
          ),
        );
      }
      f.push(
        ...contract(
          'POST /revoke',
          await formPost(full, '/revoke', client, { token: api.refresh_token! }),
          'json',
        ),
      );
      f.push(
        ...contract(
          'GET /admin/tenants (admin token)',
          await full.app.inject({ method: 'GET', url: '/admin/tenants', headers: adminBearer }),
          'json',
        ),
      );
      f.push(
        ...contract(
          'POST /admin/clients (admin token, @RequireRecentAuth)',
          await full.app.inject({
            method: 'POST',
            url: '/admin/clients',
            headers: { ...adminBearer, 'content-type': 'application/json' },
            payload: JSON.stringify({
              clientType: 'public',
              tokenEndpointAuthMethod: 'none',
              redirectUris: ['https://x.example.com/cb'],
            }),
          }),
          'json',
        ),
      );
      expect(f).toEqual([]);

      // Redis-free: POST /verify-email (Mongo only, no rate limit) still judges the token (400).
      const ve = await form('/verify-email', anonCookie, {
        _csrf: csrf.token(anon),
        token: randomBytes(32).toString('base64url'),
      });
      expect(ve.statusCode).toBe(400);
      // Redis-free endpoints keep answering (no blanket 503).
      for (const url of ['/jwks.json', '/.well-known/openid-configuration', '/health'])
        expect([url, (await full.app.inject({ method: 'GET', url })).statusCode]).toEqual([
          url,
          200,
        ]);

      // Nothing was created by the failed /admin/clients nor revoked by the failed /revoke.
      await proxy.up();
      await waitReady();
      expect((await refresh(api.refresh_token!)).statusCode).toBe(200);
      expect(
        (await full.app.inject({ method: 'GET', url: '/admin/tenants', headers: adminBearer }))
          .statusCode,
      ).toBe(200);
    },
    120_000,
  );

  const reuseEvents = () =>
    full.conn
      .model('AuditLog')
      .countDocuments({ action: 'TOKEN_REUSE_DETECTED', clientId: client.clientId });

  it.each(['refuse', 'blackhole'] as const)(
    'R2 Redis %s: 5 concurrent refreshes ⇒ all 503, family untouched; after recovery the chain continues, no reuse alarm',
    async (mode) => {
      const t = await issue(await newSession());
      const rt = t.refresh_token!;
      const before = await reuseEvents();
      if (mode === 'refuse') await proxy.refuse();
      else proxy.blackhole();
      const down = await Promise.all(Array.from({ length: 5 }, () => refresh(rt)));
      expect(down.flatMap((r, i) => contract(`refresh #${i}`, r, 'json'))).toEqual([]);

      await proxy.up();
      await waitReady();
      const r2 = await refresh(rt);
      expect(r2.statusCode).toBe(200);
      const rt2 = r2.json<{ refresh_token: string }>().refresh_token;
      const r3 = await refresh(rt2);
      expect(r3.statusCode).toBe(200);
      const { refresh_token: rt3, access_token: at3 } = r3.json<{
        refresh_token: string;
        access_token: string;
      }>();
      expect(await reuseEvents()).toBe(before); // no false reuse detection
      const fam = await full.conn
        .model('RefreshToken')
        .findOne({ tokenHash: createHash('sha256').update(rt).digest('hex') })
        .lean<{ familyId: string }>();
      const familyDocs = await full.conn
        .model('RefreshToken')
        .find({ familyId: fam!.familyId })
        .lean<Array<{ revokedAt: Date | null }>>();
      expect(familyDocs).toHaveLength(3); // rt, rt2, rt3 — no extra rotation while down
      expect(familyDocs.filter((d) => d.revokedAt == null)).toHaveLength(1);
      const ui = await full.app.inject({
        method: 'GET',
        url: '/userinfo',
        headers: { authorization: `Bearer ${at3}` },
      });
      expect(ui.statusCode).toBe(200);
      expect(rt3).toBeTruthy();
    },
    60_000,
  );

  it('R3 partial failure: Redis fails AFTER the code is consumed ⇒ 503, no token, no live family; retry invalid_grant', async () => {
    const sessionId = await newSession();
    const verifier = randomBytes(32).toString('base64url');
    const code = await authorizeCode(full, {
      ...client,
      sessionId,
      resource: FLOW_API_AUD,
      scope: SCOPE,
      verifier,
    });
    const families = () =>
      full.conn.model('RefreshToken').countDocuments({ clientId: client.clientId });
    const before = await families();
    const spy = jest
      .spyOn(SessionService.prototype, 'exists')
      .mockRejectedValue(new Error('Command timed out'));
    const body = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: FLOW_REDIRECT,
      code_verifier: verifier,
    };
    const res = await formPost(full, '/token', client, body);
    expect(spy).toHaveBeenCalled();
    expect(contract('POST /token (exists fails)', res, 'json')).toEqual([]);
    spy.mockRestore();
    expect(await families()).toBe(before); // no family minted
    const retry = await formPost(full, '/token', client, body);
    expect(retry.statusCode).toBe(400);
    expect(retry.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('R4 Redis dies after the client-auth reservation (refund fails) ⇒ refresh 200, one rotation', async () => {
    const t = await issue(await newSession());
    const spy = jest
      .spyOn(RateLimitService.prototype, 'refund')
      .mockRejectedValue(new Error('Command timed out'));
    const res = await refresh(t.refresh_token!);
    expect(spy).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    spy.mockRestore();
    const next = res.json<{ refresh_token: string }>().refresh_token;
    expect((await refresh(next)).statusCode).toBe(200);
  });

  describe('key provider down (DEBT-394)', () => {
    const failKeys = () =>
      jest
        .spyOn(full.app.get<KeyProvider>(KEY_PROVIDER), 'getPublicKeys')
        .mockRejectedValue(new Error('vault read failed: status=503'));

    it('V1 admin API with a real admin token ⇒ 503 (read + @RequireRecentAuth write); malformed ⇒ 401 / active:false', async () => {
      const sessionId = await newSession();
      const admin = await issue(sessionId, FLOW_ADMIN_AUD, ADMIN_SCOPE);
      const api = await issue(sessionId);
      failKeys();
      const bearer = { authorization: `Bearer ${admin.access_token}` };
      const f = [
        ...contract(
          'GET /admin/tenants',
          await full.app.inject({ method: 'GET', url: '/admin/tenants', headers: bearer }),
          'json',
        ),
        ...contract(
          'POST /admin/clients',
          await full.app.inject({
            method: 'POST',
            url: '/admin/clients',
            headers: { ...bearer, 'content-type': 'application/json' },
            payload: '{}',
          }),
          'json',
        ),
        ...contract(
          'POST /introspect',
          await formPost(full, '/introspect', client, { token: api.access_token }),
          'json',
        ),
      ];
      expect(f).toEqual([]);
      for (const bad of ['not-a-jwt', 'a.b.c', '']) {
        const ui = await full.app.inject({
          method: 'GET',
          url: '/userinfo',
          headers: { authorization: `Bearer ${bad}` },
        });
        expect([bad, ui.statusCode]).toEqual([bad, 401]);
        const adm = await full.app.inject({
          method: 'GET',
          url: '/admin/tenants',
          headers: { authorization: `Bearer ${bad}` },
        });
        expect([bad, adm.statusCode]).toEqual([bad, 401]);
      }
      const intro = await formPost(full, '/introspect', client, { token: 'not-a-jwt' });
      expect(intro.statusCode).toBe(200);
      expect(intro.json()).toEqual({ active: false });
    });

    it('V2 forged token with an unknown kid while keys are down ⇒ 503 / never 200 or active:true', async () => {
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      const kid = (await exportJWK(publicKey)).n!.slice(0, 16);
      const forged = await new SignJWT({
        client_id: client.clientId,
        scope: 'openid api.read',
        jti: randomUUID(),
      })
        .setProtectedHeader({ alg: 'RS256', kid, typ: 'at+jwt' })
        .setIssuer(FULL_APP_ISSUER)
        .setAudience(FLOW_API_AUD)
        .setSubject(userId)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      failKeys();
      const ui = await full.app.inject({
        method: 'GET',
        url: '/userinfo',
        headers: { authorization: `Bearer ${forged}` },
      });
      expect(contract('forged /userinfo', ui, 'json')).toEqual([]);
      const intro = await formPost(full, '/introspect', client, { token: forged });
      expect(contract('forged /introspect', intro, 'json')).toEqual([]);
      jest.restoreAllMocks();
      // Keys back: the forged token is just invalid.
      const ui2 = await full.app.inject({
        method: 'GET',
        url: '/userinfo',
        headers: { authorization: `Bearer ${forged}` },
      });
      expect(ui2.statusCode).toBe(401);
    });

    it.each([
      ['registered', POST_LOGOUT],
      ['hostile', 'https://evil.example.net/steal'],
    ])(
      'V3 POST /logout with a valid id_token_hint + %s post_logout_redirect_uri while keys are down ⇒ default redirect only, session ended',
      async (_n, target) => {
        const sessionId = await newSession();
        const t = await issue(sessionId);
        expect(t.id_token).toBeTruthy();
        // Control (keys up, GET form): a registered target IS reflected — so the V3 result below is
        // caused by the outage, not by a mis-seeded client.
        const ctl = await full.app.inject({
          method: 'GET',
          url: `/logout?${new URLSearchParams({ id_token_hint: t.id_token!, post_logout_redirect_uri: target })}`,
        });
        expect(ctl.statusCode).toBe(200);
        expect(ctl.body.includes(target)).toBe(target === POST_LOGOUT);
        failKeys();
        const res = await form(
          '/logout',
          { [SESSION_COOKIE]: sessionId },
          {
            _csrf: csrf.token(sessionId),
            id_token_hint: t.id_token!,
            post_logout_redirect_uri: target,
            state: 'st',
          },
        );
        expect(res.statusCode).toBe(302);
        expect(res.headers['location']).toBe('/login?loggedOut=1');
        expect(String(res.headers['set-cookie'])).toContain(`${SESSION_COOKIE}=;`);
        // GET form while keys are down: never reflects the target.
        const getForm = await full.app.inject({
          method: 'GET',
          url: `/logout?${new URLSearchParams({ id_token_hint: t.id_token!, post_logout_redirect_uri: target })}`,
        });
        expect(getForm.statusCode).toBe(200);
        expect(getForm.body).not.toContain(target);
        jest.restoreAllMocks();
        expect(await full.app.get(SessionService).get(sessionId)).toBeNull(); // really logged out
        const ui = await full.app.inject({
          method: 'GET',
          url: '/userinfo',
          headers: { authorization: `Bearer ${t.access_token}` },
        });
        expect(ui.statusCode).toBe(401); // tombstoned sid
      },
    );
  });

  it.each(['refuse', 'blackhole'] as const)(
    'S1 app.close() with Redis %s returns < 10 s and the client stops reconnecting (DEBT-397, in-process)',
    async (mode) => {
      const p = await startRedisProxy();
      // Counting front door: app -> counter -> proxy. Every (re)connect attempt of the app's client
      // is one accepted connection here, whatever the proxy then does with it.
      let connects = 0;
      const counter = net.createServer((c) => {
        connects++;
        const up = net.connect(p.port, '127.0.0.1');
        c.on('error', () => c.destroy());
        up.on('error', () => c.destroy());
        c.on('close', () => up.destroy());
        up.on('close', () => c.destroy());
        c.pipe(up).pipe(c);
      });
      await new Promise<void>((r) => counter.listen(0, '127.0.0.1', r));
      const port = (counter.address() as net.AddressInfo).port;
      const app = await bootFullApp({
        name: 'b73c-close',
        env: { REDIS_URL: `redis://127.0.0.1:${port}` },
      });
      try {
        // leave a queued command behind like /ready does
        if (mode === 'refuse') await p.refuse();
        else p.blackhole();
        expect((await app.app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(503);
        const start = Date.now();
        await app.close();
        expect(Date.now() - start).toBeLessThan(10_000);
        const after = connects;
        await new Promise((r) => setTimeout(r, 4000));
        expect(connects - after).toBe(0); // no reconnect loop keeping the process alive
      } finally {
        await new Promise<void>((r) => counter.close(() => r()));
        await p.close();
      }
    },
    60_000,
  );

  describe('C1 Sentinel config', () => {
    // The booted app's hermetic env without REDIS_URL (filled in per case).
    const base = (): Record<string, string> =>
      Object.fromEntries(Object.entries(full.env).filter(([k]) => k !== 'REDIS_URL'));
    const CANARY = 'canary-zq81-';
    const errorOf = (env: Record<string, string>): string => {
      try {
        validateEnv(env);
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    };
    it.each([
      [
        'both',
        {
          REDIS_URL: `redis://:${CANARY}url@h:6379`,
          REDIS_SENTINELS: 'h:26379',
          REDIS_SENTINEL_MASTER: 'm',
          REDIS_SENTINEL_PASSWORD: `${CANARY}sp`,
          REDIS_PASSWORD: `${CANARY}rp`,
        },
      ],
      ['neither', { REDIS_PASSWORD: `${CANARY}rp`, REDIS_SENTINEL_PASSWORD: `${CANARY}sp` }],
      ['malformed sentinels', { REDIS_SENTINELS: `${CANARY}h:99999`, REDIS_SENTINEL_MASTER: 'm' }],
      ['bad master', { REDIS_SENTINELS: 'h:1', REDIS_SENTINEL_MASTER: `${CANARY} m/x` }],
      ['bad db', { REDIS_SENTINELS: 'h:1', REDIS_SENTINEL_MASTER: 'm', REDIS_DB: `${CANARY}` }],
    ])('%s ⇒ refused, names a variable, never echoes a value', (_n, extra) => {
      const msg = errorOf({ ...base(), ...extra });
      expect(msg).toMatch(/REDIS_/);
      expect(msg).not.toContain(CANARY);
      expect(msg).not.toContain('h:26379');
    });
    it('sanity: a valid sentinel env passes', () => {
      expect(errorOf({ ...base(), REDIS_SENTINELS: 'h:26379', REDIS_SENTINEL_MASTER: 'm' })).toBe(
        '',
      );
    });
  });
});
