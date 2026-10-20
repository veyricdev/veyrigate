import cookie from '@fastify/cookie';
import { ConfigService } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import IORedis from 'ioredis';
import { Types, type Model } from 'mongoose';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { deriveS256Challenge } from '../src/common/crypto/pkce.util';
import { RedisService } from '../src/database/redis/redis.service';
import { RateLimitService } from '../src/modules/security/rate-limit/rate-limit.service';
import { KEY_PROVIDER } from '../src/modules/keys/key-provider';
import { LocalKeyProvider } from '../src/modules/keys/local-key-provider';
import { TokenSigner } from '../src/modules/keys/token-signer';
import { TokenVerifier } from '../src/modules/keys/token-verifier';
import { ClientService, type Client } from '../src/modules/clients/client.service';
import { ClientCredentialService } from '../src/modules/clients/client-credential.service';
import { ClientAuthenticationService } from '../src/modules/clients/client-authentication.service';
import { ClientCorsService } from '../src/modules/clients/client-cors.service';
import { AuditService } from '../src/modules/security/audit/audit.service';
import { AuthorizationCodeService } from '../src/modules/oauth/code/authorization-code.service';
import { SessionService } from '../src/modules/sessions/session.service';
import { TokenController } from '../src/modules/oauth/token/token.controller';
import { TokenService } from '../src/modules/oauth/token/token.service';
import { RefreshTokenService } from '../src/modules/oauth/token/refresh-token.service';
import { ResourceService, type Resource } from '../src/modules/resources/resource.service';
import { IntrospectController } from '../src/modules/oauth/introspect/introspect.controller';
import { UserinfoController } from '../src/modules/oauth/userinfo/userinfo.controller';
import { UiController } from '../src/modules/ui/ui.controller';
import { CsrfGuard, CsrfService } from '../src/modules/ui/csrf.service';
import { HtmlExceptionFilter } from '../src/modules/ui/html-exception.filter';
import { SESSION_COOKIE, SessionCookie } from '../src/modules/sessions/session.cookie';
import { LogoutService } from '../src/modules/oauth/logout/logout.service';
import { AuthorizeRequestContextService } from '../src/modules/oauth/authorize/authorize-request-context.service';
import { AuthenticationService } from '../src/modules/authentication/authentication.service';
import { UserService } from '../src/modules/identity/user.service';
import { UserTenantService } from '../src/modules/identity/user-tenant.service';
import { ConsentService } from '../src/modules/oauth/consent/consent.service';
import { seedCodeGrant } from './oauth-fixtures';
import { MAILER } from '../src/modules/mailer/mailer';

const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-sessrefl-${Date.now()}?directConnection=true`;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';
const RUN = `sr${Date.now()}`;
const ISSUER = 'http://localhost:4000';
// `allowedResources[]` holds resourceIds (spec §7); `aud`/`RefreshToken.resource` hold the URI
// identifier. The `Resource` registry (Task 0) maps between them.
const RESOURCE = 'https://api.example.com/';
const RESOURCE_ID = 'res-api';
const REDIRECT = 'https://app.example.com/callback';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = deriveS256Challenge(VERIFIER);
const APP_CLIENT = `${RUN}-app`;
const ACCESS_TTL = 900;

const cfg = {
  getOrThrow: (ns: string) => {
    if (ns === 'app') return { nodeEnv: 'production', issuer: ISSUER };
    if (ns === 'token')
      return {
        accessTokenTtl: ACCESS_TTL,
        refreshTokenTtl: 2592000,
        sessionIdleTtl: 28800,
        sessionAbsoluteTtl: 2592000,
      };
    if (ns === 'client') return { secretGraceTtl: 3600 };
    if (ns === 'consent') return { policyVersion: '1', termsVersion: '1' };
    // B7.1 SE12: UiController (real POST /logout) reads these.
    if (ns === 'session') return { cookieSecure: false };
    if (ns === 'security')
      return {
        rateLimitWindow: 60,
        rateLimitMax: 100,
        // High thresholds so the client-auth failure limiter never fires in these tests.
        clientAuthFailIpMax: 100000,
        clientAuthFailClientMax: 100000,
        csrfSecret: 'sessrefl-csrf-secret',
      };
    throw new Error(`unexpected ns ${ns}`);
  },
} as unknown as ConfigService;

const form = (fields: Record<string, string>): string =>
  Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
const basic = (id: string, secret: string): string =>
  'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');

describe('session reflection e2e: logout/revoke -> /introspect + /userinfo (DEBT-037)', () => {
  let app: NestFastifyApplication;
  let redis: IORedis;
  let keyDir: string;
  let codes: AuthorizationCodeService;
  let sessions: SessionService;
  let signer: TokenSigner;
  let csrf: CsrfService;
  let userModel: Model<Record<string, unknown>>;
  let clientModel: Model<Client>;
  let resourceModel: Model<Resource>;
  let appSecret = '';
  let userId = '';

  /** Run 35: a directly minted code's owner must pass the code grant re-check (user/member/consent). */
  const createCode = async (data: Record<string, unknown>) => {
    await seedCodeGrant(userModel.db, data as never, 'tenant-A');
    return codes.create(data as never);
  };

  /** Decode a JWT payload without verifying the signature (test-only inspection). */
  const payloadOf = (jwt: string): Record<string, unknown> =>
    JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));

  const token = (payload: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      payload,
    });
  const introspect = (tok: string) =>
    app.inject({
      method: 'POST',
      url: '/introspect',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: basic(APP_CLIENT, appSecret),
      },
      payload: form({ token: tok }),
    });
  const userinfo = (tok: string) =>
    app.inject({ method: 'GET', url: '/userinfo', headers: { authorization: `Bearer ${tok}` } });

  async function grantForSession(scope = 'openid profile offline_access') {
    const u = userId;
    const { session } = await sessions.create(u, 'tenant-A');
    const { code } = await createCode({
      clientId: APP_CLIENT,
      redirectUri: REDIRECT,
      codeChallenge: CHALLENGE,
      resource: RESOURCE,
      scope,
      userId: u,
      authTime: session.authTime,
      sessionRef: session.ref,
    } as never);
    const res = await token(
      form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: APP_CLIENT,
        code_verifier: VERIFIER,
      }),
      { authorization: basic(APP_CLIENT, appSecret) },
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    return {
      sessionId: session.ref,
      userId: u,
      access: body.access_token as string,
      refresh: body.refresh_token as string | undefined,
    };
  }

  beforeAll(async () => {
    keyDir = await mkdtemp(join(tmpdir(), 'vg-sessrefl-int-'));
    const provider = new LocalKeyProvider(keyDir);
    await provider.init();
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(MONGO_URI, {
          serverSelectionTimeoutMS: 5000,
          retryAttempts: 5,
          retryDelay: 1000,
        }),
        MongooseModule.forFeature(MODELS),
      ],
      controllers: [TokenController, IntrospectController, UserinfoController, UiController],
      providers: [
        TokenService,
        RefreshTokenService,
        ResourceService,
        AuthorizationCodeService,
        SessionService,
        ClientService,
        ClientCredentialService,
        ClientAuthenticationService,
        ClientCorsService,
        AuditService,
        RateLimitService,
        TokenSigner,
        TokenVerifier,
        // B7.1 SE12: the real POST /logout path (revoke families + session + SWEEP).
        SessionCookie,
        CsrfService,
        CsrfGuard,
        HtmlExceptionFilter,
        LogoutService,
        AuthorizeRequestContextService,
        AuthenticationService,
        UserService,
        UserTenantService,
        ConsentService,
        { provide: MAILER, useValue: { send: async () => undefined } },
        { provide: KEY_PROVIDER, useValue: provider },
        { provide: RedisService, useValue: new RedisService(redis) },
        { provide: ConfigService, useValue: cfg },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(cookie);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    codes = moduleRef.get(AuthorizationCodeService);
    sessions = moduleRef.get(SessionService);
    signer = moduleRef.get(TokenSigner);
    csrf = moduleRef.get(CsrfService);
    userModel = app.get<Model<Record<string, unknown>>>(getModelToken('User'));
    clientModel = app.get<Model<Client>>(getModelToken('Client'));
    resourceModel = app.get<Model<Resource>>(getModelToken('Resource'));
    await syncAllIndexes(clientModel.db);

    const user = await userModel.create({ email: `${RUN}@example.com` });
    userId = (user._id as Types.ObjectId).toHexString();

    // Register the resource whose identifier is the issued tokens' `aud`/`resource`; APP_CLIENT
    // holds its resourceId (resolved to this identifier by the liveness/rotation gates, Task 0).
    const resources = new ResourceService(resourceModel);
    await resources.create({ resourceId: RESOURCE_ID, identifier: RESOURCE });

    const clients = new ClientService(clientModel, cfg);
    const creds = moduleRef.get(ClientCredentialService);
    await clients.create({
      clientId: APP_CLIENT,
      clientType: 'confidential',
      tokenEndpointAuthMethod: 'client_secret_basic',
      redirectUris: [REDIRECT],
      grantTypes: ['authorization_code', 'refresh_token'],
      allowedResources: [RESOURCE_ID],
      tenantId: 'tenant-A',
    });
    appSecret = (await creds.createSecret(APP_CLIENT)).secret;
  }, 60_000);

  afterAll(async () => {
    if (clientModel) await clientModel.db.dropDatabase();
    if (redis) {
      for (const p of ['authz_code:*', 'sess:*', 'sess_end:*', 'user_sess:*', 'sess_rp:*']) {
        const keys = await redis.keys(p);
        if (keys.length) await redis.del(...keys);
      }
      await redis.quit();
    }
    if (app) await app.close();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  it('(b) local logout: AT of that session => introspect active:false + userinfo 401; another session unaffected', async () => {
    const a = await grantForSession();
    const b = await grantForSession();
    expect((await introspect(a.access)).json().active).toBe(true);
    expect((await userinfo(a.access)).statusCode).toBe(200);

    await sessions.revokeByDevice(a.userId, a.sessionId);

    expect((await introspect(a.access)).json()).toEqual({ active: false });
    expect((await userinfo(a.access)).statusCode).toBe(401);
    expect((await introspect(b.access)).json().active).toBe(true);
    expect((await userinfo(b.access)).statusCode).toBe(200);
  });

  it('(b) global logout (revokeAllForUser) => every AT of that user inactive', async () => {
    const a = await grantForSession();
    const b = await grantForSession();
    await sessions.revokeAllForUser(userId);
    expect((await introspect(a.access)).json()).toEqual({ active: false });
    expect((await introspect(b.access)).json()).toEqual({ active: false });
    expect((await userinfo(a.access)).statusCode).toBe(401);
  });

  it('(c) offline_access NOT regressed: deleting sess:{ref} directly keeps AT active + userinfo 200', async () => {
    const g = await grantForSession();
    await redis.del(`sess:${g.sessionId}`);
    expect(await sessions.isEnded(g.sessionId)).toBe(false);
    expect((await introspect(g.access)).json().active).toBe(true);
    expect((await userinfo(g.access)).statusCode).toBe(200);
  });

  it('(d) AT minted from a refresh BEFORE logout carries the sid => inactive after logout', async () => {
    const g = await grantForSession();
    const rotated = await token(
      form({
        grant_type: 'refresh_token',
        refresh_token: g.refresh as string,
        client_id: APP_CLIENT,
      }),
      { authorization: basic(APP_CLIENT, appSecret) },
    );
    expect(rotated.statusCode).toBe(200);
    const at2 = rotated.json().access_token as string;
    expect((await introspect(at2)).json().active).toBe(true);

    await sessions.revokeByDevice(g.userId, g.sessionId);
    expect((await introspect(at2)).json()).toEqual({ active: false });
    expect((await userinfo(at2)).statusCode).toBe(401);
  });

  it('(e) tombstone TTL is within (accessTTL, accessTTL+60s]', async () => {
    const g = await grantForSession();
    await sessions.revokeByDevice(g.userId, g.sessionId);
    const pttl = await redis.pttl(`sess_end:${g.sessionId}`);
    expect(pttl).toBeGreaterThan(ACCESS_TTL * 1000);
    expect(pttl).toBeLessThanOrEqual(ACCESS_TTL * 1000 + 60_000);
  });

  // QA (run 17): acceptance (a) second clause + (f) baseline + sid-exposure, verified end-to-end
  // against real Redis+Mongo (the introspect/userinfo unit specs stub `isEnded`; these exercise the
  // real tombstone path through the actual endpoints).

  it('QA (a): an access token minted from a refresh rotation carries sid === the family sessionRef', async () => {
    const g = await grantForSession();
    // Sanity: the code-grant AT already carries the session ref.
    expect(payloadOf(g.access).sid).toBe(g.sessionId);

    const rotated = await token(
      form({
        grant_type: 'refresh_token',
        refresh_token: g.refresh as string,
        client_id: APP_CLIENT,
      }),
      { authorization: basic(APP_CLIENT, appSecret) },
    );
    expect(rotated.statusCode).toBe(200);
    const at2 = rotated.json().access_token as string;
    // The rotated AT inherits the SAME sid (not undefined, not a new value).
    expect(payloadOf(at2).sid).toBe(g.sessionId);
    // And it reflects liveness through that sid: still live before any logout.
    expect((await introspect(at2)).json().active).toBe(true);
  });

  it('QA (f): a legacy access token WITHOUT sid stays active:true + userinfo 200 even AFTER that user is logged out', async () => {
    const g = await grantForSession();
    // Mint a sid-less at+jwt through the real signer (pre-B4.7 family shape): same sub/aud/scope,
    // but NO `sid` claim.
    const legacy = await signer.sign(
      { scope: 'openid profile', client_id: APP_CLIENT },
      { audience: RESOURCE, subject: g.userId, expiresInSec: ACCESS_TTL, typ: 'at+jwt' },
    );
    expect(payloadOf(legacy).sid).toBeUndefined();
    expect((await introspect(legacy)).json().active).toBe(true);
    expect((await userinfo(legacy)).statusCode).toBe(200);

    // End every session for this user (writes tombstones). The sid-bearing AT dies (covered by (b)),
    // but the sid-less legacy token MUST remain valid — the tombstone path never over-blocks it.
    await sessions.revokeAllForUser(g.userId);
    expect((await introspect(g.access)).json()).toEqual({ active: false }); // control: sid token died

    expect((await introspect(legacy)).json().active).toBe(true);
    expect((await userinfo(legacy)).statusCode).toBe(200);
  });

  it('QA: /introspect never surfaces the session identifier (sid) in the response body', async () => {
    const g = await grantForSession();
    const body = (await introspect(g.access)).json();
    expect(body.active).toBe(true);
    expect(body).not.toHaveProperty('sid');
    // Belt-and-suspenders: the raw JSON string must not leak the session ref either.
    expect(JSON.stringify(body)).not.toContain(g.sessionId);
  });

  // DEBT-052: re-login (session fixation rotate, §9.6) must NOT tombstone the old session and must
  // NOT revoke its `offline_access` family (§8 limit 1). Only active termination (logout / device
  // revoke / reset / /revoke / reuse) tears a family down.
  it('DEBT-052: re-login keeps the old offline_access family alive (refresh rotates, AT active)', async () => {
    const u = userId;
    const { id: oldId, session } = await sessions.create(u, 'tenant-A');
    const { code } = await createCode({
      clientId: APP_CLIENT,
      redirectUri: REDIRECT,
      codeChallenge: CHALLENGE,
      resource: RESOURCE,
      scope: 'openid profile offline_access',
      userId: u,
      authTime: session.authTime,
      sessionRef: session.ref,
    } as never);
    const granted = await token(
      form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: APP_CLIENT,
        code_verifier: VERIFIER,
      }),
      { authorization: basic(APP_CLIENT, appSecret) },
    );
    expect(granted.statusCode).toBe(200);
    const refresh = granted.json().refresh_token as string;

    // Re-login with the old cookie id: rotates the session cookie only (no tombstone, no revoke).
    await sessions.establish(oldId, u, 'tenant-A');
    expect(await sessions.isEnded(session.ref)).toBe(false); // NOT actively ended

    // The offline_access family still rotates and the new AT is active (not killed by a tombstone).
    const rotated = await token(
      form({ grant_type: 'refresh_token', refresh_token: refresh, client_id: APP_CLIENT }),
      { authorization: basic(APP_CLIENT, appSecret) },
    );
    expect(rotated.statusCode).toBe(200);
    const at2 = rotated.json().access_token as string;
    expect((await introspect(at2)).json().active).toBe(true);
  });

  it('B7.1 SE12: K=10 rounds of REAL concurrent POST /logout racing POST /token (code, offline_access) => no live family of the ended session survives', async () => {
    const refreshModel = app.get<Model<Record<string, unknown>>>(getModelToken('RefreshToken'));
    for (let k = 0; k < 10; k++) {
      const { id, session } = await sessions.create(userId, 'tenant-A');
      const { code } = await createCode({
        clientId: APP_CLIENT,
        redirectUri: REDIRECT,
        codeChallenge: CHALLENGE,
        resource: RESOURCE,
        scope: 'openid profile offline_access',
        userId,
        authTime: session.authTime,
        sessionRef: session.ref,
      } as never);
      // Stagger the logout start by 0..90 ms across rounds so both orders (logout first / exchange
      // first) and the overlapping middle are hit; each round is still two in-flight requests.
      const [logout, tok] = await Promise.all([
        new Promise((r) => setTimeout(r, k * 10)).then(() =>
          app.inject({
            method: 'POST',
            url: '/logout',
            headers: { cookie: `${SESSION_COOKIE}=${id}` },
            payload: { _csrf: csrf.token(id) },
          }),
        ),
        token(
          form({
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT,
            client_id: APP_CLIENT,
            code_verifier: VERIFIER,
          }),
          { authorization: basic(APP_CLIENT, appSecret) },
        ),
      ]);
      expect(logout.statusCode).toBe(302);
      expect([200, 400]).toContain(tok.statusCode); // never a 5xx
      expect(await sessions.get(id)).toBeNull();
      // Invariant: no refresh doc bound to the ended session is still active (round tagged).
      const live = await refreshModel.countDocuments({ sessionRef: session.ref, revokedAt: null });
      expect({ round: k, token: tok.statusCode, live }).toEqual({
        round: k,
        token: tok.statusCode,
        live: 0,
      });
      if (tok.statusCode === 200) {
        const rt = tok.json().refresh_token as string;
        expect(rt).toBeDefined();
        const rotated = await token(form({ grant_type: 'refresh_token', refresh_token: rt }), {
          authorization: basic(APP_CLIENT, appSecret),
        });
        expect(rotated.statusCode).toBe(400);
        expect(rotated.json().error).toBe('invalid_grant');
      } else {
        expect(tok.json().error).toBe('invalid_grant');
      }
    }
  });
});
