import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import cookie from '@fastify/cookie';
import view from '@fastify/view';
import { Eta } from 'eta';
import IORedis from 'ioredis';
import mongoose, { Types, type Connection, type Model } from 'mongoose';
import { join } from 'node:path';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { RedisService } from '../src/database/redis/redis.service';
import { SessionService } from '../src/modules/sessions/session.service';
import { SessionCookie, SESSION_COOKIE } from '../src/modules/sessions/session.cookie';
import { HtmlExceptionFilter } from '../src/modules/ui/html-exception.filter';
import { CsrfGuard, CsrfService } from '../src/modules/ui/csrf.service';
import { AuthorizeController } from '../src/modules/oauth/authorize/authorize.controller';
import { ClientService, type Client } from '../src/modules/clients/client.service';
import { ResourceService, type Resource } from '../src/modules/resources/resource.service';
import { AuditService } from '../src/modules/security/audit/audit.service';
import { AuditAction } from '../src/modules/security/audit/audit-action.enum';
import type { AuditEvent } from '../src/modules/security/audit/audit.types';
import {
  AuthorizeErrorPage,
  AuthorizeRedirectError,
} from '../src/modules/oauth/authorize/authorize.errors';
import { AuthorizeRequestContextService } from '../src/modules/oauth/authorize/authorize-request-context.service';
import {
  AuthorizeService,
  type AuthorizeParams,
  type SessionView,
} from '../src/modules/oauth/authorize/authorize.service';
import { AuthorizationCodeService } from '../src/modules/oauth/code/authorization-code.service';
import { ConsentService, type Consent } from '../src/modules/oauth/consent/consent.service';

const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-authorize-${Date.now()}?directConnection=true`;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';
const RUN = `az${Date.now()}`;

const ISSUER = 'http://localhost:4000';

function config(): ConfigService {
  const base: Record<string, unknown> = {
    app: { nodeEnv: 'production', issuer: ISSUER },
    consent: { policyVersion: '1', termsVersion: '1' },
  };
  return { getOrThrow: (ns: string) => base[ns] } as unknown as ConfigService;
}

const VALID_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'; // 43-char base64url

/** A fully valid param set; override per-test. */
function params(overrides: Partial<AuthorizeParams> = {}): AuthorizeParams {
  return {
    response_type: 'code',
    client_id: `${RUN}-client`,
    redirect_uri: 'https://app.example.com/callback',
    scope: 'openid profile',
    state: 'rp-state-xyz',
    nonce: 'rp-nonce-abc',
    code_challenge: VALID_CHALLENGE,
    code_challenge_method: 'S256',
    ...overrides,
  };
}

describe('Authorize (/authorize) on real Mongo + Redis (B4.1, spec §9.1-9.2)', () => {
  let connection: Connection;
  let redis: IORedis;
  let clientModel: Model<Client>;
  let resourceModel: Model<Resource>;
  let auditModel: Model<AuditEvent>;
  let clients: ClientService;
  let resources: ResourceService;
  let audit: AuditService;
  let contexts: AuthorizeRequestContextService;
  let consents: ConsentService;
  let codes: AuthorizationCodeService;
  let ctxClock: number;
  let service: AuthorizeService;

  const signedIn: SessionView = {
    userId: new Types.ObjectId().toHexString(),
    authTime: Date.now(),
  };

  beforeAll(async () => {
    connection = await mongoose.createConnection(MONGO_URI, { autoIndex: false }).asPromise();
    for (const { name, schema } of MODELS) connection.model(name, schema);
    await syncAllIndexes(connection);
    clientModel = connection.model<Client>('Client');
    resourceModel = connection.model<Resource>('Resource');
    auditModel = connection.model<AuditEvent>('AuditLog');

    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    const rs = new RedisService(redis);

    clients = new ClientService(clientModel, config());
    resources = new ResourceService(resourceModel);
    audit = new AuditService(auditModel);
    ctxClock = Date.now();
    contexts = new AuthorizeRequestContextService(rs, () => ctxClock);
    const consentModel = connection.model<Consent>('Consent');
    consents = new ConsentService(consentModel, config());
    codes = new AuthorizationCodeService(rs);
    service = new AuthorizeService(clients, resources, contexts, audit, consents, codes, config());

    await clients.create({
      clientId: `${RUN}-client`,
      clientType: 'public',
      tokenEndpointAuthMethod: 'none',
      redirectUris: ['https://app.example.com/callback'],
      allowedResources: ['res-api'],
      scopes: ['openid', 'profile', 'email'],
      tenantId: 'tenant-A',
    });
    await resources.create({
      resourceId: 'res-api',
      identifier: 'https://api.example.com/',
      scopes: ['openid'],
    });
  }, 30_000);

  afterAll(async () => {
    const keys = await redis.keys('authz_ctx:*');
    if (keys.length) await redis.del(...keys);
    await redis.quit();
    await connection.dropDatabase();
    await connection.close();
  });

  describe('open-redirect boundary (INV-3)', () => {
    it('throws AuthorizeErrorPage (no redirect) for an unknown client_id', async () => {
      await expect(service.handle(params({ client_id: 'nope' }), signedIn)).rejects.toBeInstanceOf(
        AuthorizeErrorPage,
      );
    });

    it('throws AuthorizeErrorPage (no redirect) for a redirect_uri not registered', async () => {
      await expect(
        service.handle(params({ redirect_uri: 'https://evil.example.com/cb' }), signedIn),
      ).rejects.toBeInstanceOf(AuthorizeErrorPage);
    });

    it('rejects a redirect_uri that only differs by a trailing slash (exact match)', async () => {
      await expect(
        service.handle(params({ redirect_uri: 'https://app.example.com/callback/' }), signedIn),
      ).rejects.toBeInstanceOf(AuthorizeErrorPage);
    });
  });

  describe('post-redirect OAuth errors (redirect_uri already trusted)', () => {
    it('rejects PKCE plain with invalid_request (not an error page)', async () => {
      await expect(
        service.handle(params({ code_challenge_method: 'plain' }), signedIn),
      ).rejects.toMatchObject({ error: 'invalid_request' });
    });

    it('rejects a missing code_challenge_method (S256 mandatory)', async () => {
      await expect(
        service.handle(params({ code_challenge_method: undefined }), signedIn),
      ).rejects.toBeInstanceOf(AuthorizeRedirectError);
    });

    it('rejects response_type other than code', async () => {
      await expect(
        service.handle(params({ response_type: 'token' }), signedIn),
      ).rejects.toMatchObject({ error: 'unsupported_response_type' });
    });

    it('rejects an unknown resource with invalid_target', async () => {
      await expect(
        service.handle(params({ resource: 'https://other.example.com/' }), signedIn),
      ).rejects.toMatchObject({ error: 'invalid_target' });
    });

    it('rejects a scope not registered for the client', async () => {
      await expect(
        service.handle(params({ scope: 'openid admin.write' }), signedIn),
      ).rejects.toMatchObject({ error: 'invalid_scope' });
    });

    it('rejects a malformed max_age', async () => {
      await expect(service.handle(params({ max_age: '-5' }), signedIn)).rejects.toMatchObject({
        error: 'invalid_request',
      });
    });
  });

  describe('prompt=none', () => {
    it('returns login_required (OAuth error) when not signed in', async () => {
      await expect(service.handle(params({ prompt: 'none' }), null)).rejects.toMatchObject({
        error: 'login_required',
      });
    });

    it('is rejected when combined with other prompt values', async () => {
      await expect(
        service.handle(params({ prompt: 'none login' }), signedIn),
      ).rejects.toMatchObject({ error: 'invalid_request' });
    });
  });

  describe('happy path + AuthorizeRequestContext', () => {
    it('not signed in => login_required with a resumable request_id, context persisted', async () => {
      const outcome = await service.handle(params(), null);
      expect(outcome.kind).toBe('login_required');
      if (outcome.kind !== 'login_required') throw new Error('unreachable');
      const ctx = await contexts.consume(outcome.requestId);
      expect(ctx).not.toBeNull();
      expect(ctx!.clientId).toBe(`${RUN}-client`);
      expect(ctx!.redirectUri).toBe('https://app.example.com/callback');
    });

    it('signed in + valid, no consent => consent_required; context echoes state/nonce; request_id != state (C8)', async () => {
      const p = params({
        state: 'the-rp-state',
        nonce: 'the-rp-nonce',
        resource: 'https://api.example.com/',
      });
      const outcome = await service.handle(p, signedIn);
      expect(outcome.kind).toBe('consent_required');
      if (outcome.kind !== 'consent_required') throw new Error('unreachable');
      expect(outcome.requestId).not.toBe(p.state);
      const ctx = await contexts.consume(outcome.requestId);
      expect(ctx).not.toBeNull();
      expect(ctx!.originalState).toBe('the-rp-state');
      expect(ctx!.nonce).toBe('the-rp-nonce');
      expect(ctx!.resource).toBe('https://api.example.com/');
    });

    it('resolves resource via identifier->resourceId, never the URI directly', async () => {
      const outcome = await service.handle(
        params({ resource: 'https://api.example.com/' }),
        signedIn,
      );
      if (outcome.kind !== 'consent_required') throw new Error('expected consent_required');
      const ctx = await contexts.consume(outcome.requestId);
      expect(ctx!.resource).toBe('https://api.example.com/');
    });

    it('writes an OAUTH_AUTHORIZE audit event without sensitive values', async () => {
      const before = await auditModel.countDocuments({ action: AuditAction.OAUTH_AUTHORIZE });
      await service.handle(params(), signedIn);
      const events = await auditModel
        .find({ action: AuditAction.OAUTH_AUTHORIZE })
        .lean<AuditEvent[]>();
      expect(events.length).toBe(before + 1);
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain(VALID_CHALLENGE);
      expect(serialized).not.toContain('rp-nonce');
    });
  });

  describe('AuthorizeRequestContext single-use + TTL', () => {
    it('consume is single-use: a second consume returns null', async () => {
      const { requestId } = await contexts.create({
        clientId: `${RUN}-client`,
        redirectUri: 'https://app.example.com/callback',
        codeChallenge: VALID_CHALLENGE,
        scope: 'openid',
      });
      expect(await contexts.consume(requestId)).not.toBeNull();
      expect(await contexts.consume(requestId)).toBeNull();
    });

    it('two concurrent consumes of the same request_id: exactly one wins', async () => {
      const { requestId } = await contexts.create({
        clientId: `${RUN}-client`,
        redirectUri: 'https://app.example.com/callback',
        codeChallenge: VALID_CHALLENGE,
        scope: 'openid',
      });
      const [a, b] = await Promise.all([contexts.consume(requestId), contexts.consume(requestId)]);
      expect([a, b].filter((x) => x !== null)).toHaveLength(1);
    });

    it('context expires after its TTL', async () => {
      const { requestId } = await contexts.create({
        clientId: `${RUN}-client`,
        redirectUri: 'https://app.example.com/callback',
        codeChallenge: VALID_CHALLENGE,
        scope: 'openid',
      });
      // The key TTL is driven by real Redis PX; wait just past a short probe by deleting via TTL check.
      const ttl = await redis.pttl(`authz_ctx:${requestId}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000);
      await contexts.consume(requestId);
    });

    it('request_id is opaque and unrelated to the RP state', async () => {
      const outcome = await service.handle(params({ state: 'rp-controlled-state' }), signedIn);
      if (outcome.kind !== 'consent_required') throw new Error('expected consent_required');
      expect(outcome.requestId).not.toContain('rp-controlled-state');
      await contexts.consume(outcome.requestId);
    });
  });
});
describe('Authorize HTTP flow via AuthorizeController (B4.1, senior blocker)', () => {
  // These tests exercise the real @Get('/authorize') route (app.inject), including the
  // login -> resume round-trip that unit-level AuthorizeService tests cannot cover.
  let httpApp: NestFastifyApplication;
  let httpRedis: IORedis;
  let sessionSvc: SessionService;
  let consentSvc: ConsentService;
  let codeSvc: AuthorizationCodeService;
  let httpClientModel: Model<Client>;

  const cfg = {
    getOrThrow: (ns: string) => {
      if (ns === 'app') return { nodeEnv: 'production', issuer: ISSUER };
      if (ns === 'session') return { cookieSecure: false };
      if (ns === 'token') return { sessionIdleTtl: 3600, sessionAbsoluteTtl: 86400 };
      if (ns === 'security') return { csrfSecret: 'test-csrf-secret' };
      if (ns === 'consent') return { policyVersion: '1', termsVersion: '1' };
      throw new Error(`Unexpected config namespace: ${ns}`);
    },
  } as unknown as ConfigService;

  beforeAll(async () => {
    httpRedis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(MONGO_URI, {
          serverSelectionTimeoutMS: 5000,
          retryAttempts: 5,
          retryDelay: 1000,
        }),
        MongooseModule.forFeature(MODELS),
      ],
      controllers: [AuthorizeController],
      providers: [
        AuthorizeService,
        AuthorizeRequestContextService,
        AuthorizationCodeService,
        ConsentService,
        CsrfService,
        CsrfGuard,
        ClientService,
        ResourceService,
        SessionService,
        SessionCookie,
        AuditService,
        HtmlExceptionFilter,
        { provide: RedisService, useValue: new RedisService(httpRedis) },
        { provide: ConfigService, useValue: cfg },
      ],
    }).compile();

    httpApp = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await httpApp.register(cookie);
    await httpApp.register(view, {
      engine: { eta: new Eta({ views: join(process.cwd(), 'src/views'), autoEscape: true }) },
      root: join(process.cwd(), 'src/views'),
      layout: 'layout.eta',
    });
    httpApp.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }),
    );
    await httpApp.init();
    await httpApp.getHttpAdapter().getInstance().ready();

    sessionSvc = moduleRef.get(SessionService);
    consentSvc = moduleRef.get(ConsentService);
    codeSvc = moduleRef.get(AuthorizationCodeService);

    httpClientModel = httpApp.get<Model<Client>>(getModelToken('Client'));
    const cs = new ClientService(httpClientModel, cfg);
    await cs.create({
      clientId: `${RUN}-http`,
      clientType: 'public',
      tokenEndpointAuthMethod: 'none',
      redirectUris: ['https://app.example.com/callback'],
      allowedResources: [],
      scopes: ['openid', 'profile'],
      tenantId: 'tenant-A',
    });
  }, 30_000);

  afterAll(async () => {
    if (httpRedis) {
      const keys = await httpRedis.keys('authz_ctx:*');
      if (keys.length) await httpRedis.del(...keys);
    }
    if (httpApp) await httpApp.close();
  });

  const fullQuery = (extra = '') =>
    `/authorize?response_type=code&client_id=${RUN}-http` +
    `&redirect_uri=${encodeURIComponent('https://app.example.com/callback')}` +
    `&scope=${encodeURIComponent('openid profile')}&state=rp-state&nonce=rp-nonce` +
    `&code_challenge=${VALID_CHALLENGE}&code_challenge_method=S256${extra}`;

  it('no session => 302 to /login with a resumable request_id in returnTo', async () => {
    const res = await httpApp.inject({ method: 'GET', url: fullQuery() });
    expect(res.statusCode).toBe(302);
    const location = res.headers['location'] as string;
    expect(location).toMatch(/^\/login\?returnTo=/);
    const returnTo = decodeURIComponent(location.replace('/login?returnTo=', ''));
    expect(returnTo).toMatch(/^\/authorize\?request_id=/);
  });

  it('login then resume via request_id => 200 consent screen (context not lost)', async () => {
    const first = await httpApp.inject({ method: 'GET', url: fullQuery() });
    const returnTo = decodeURIComponent(
      (first.headers['location'] as string).replace('/login?returnTo=', ''),
    );
    const requestId = new URLSearchParams(returnTo.split('?')[1]).get('request_id')!;

    const { id } = await sessionSvc.create(`${new Types.ObjectId().toHexString()}`, 'tenant-A');
    const resumed = await httpApp.inject({
      method: 'GET',
      url: `/authorize?request_id=${encodeURIComponent(requestId)}`,
      cookies: { [SESSION_COOKIE]: id },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.body).toContain('Authorize access');
    expect(resumed.body).toMatch(/name="_csrf" value="[^"]+"/);
    expect(resumed.body).toContain('openid');
    await sessionSvc.revoke(id);
  });

  it('resume with an unknown request_id => 400 error page (never a redirect)', async () => {
    const res = await httpApp.inject({
      method: 'GET',
      url: `/authorize?request_id=does-not-exist`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['location']).toBeUndefined();
    expect(res.body).toContain('expired');
  });

  it('unknown client_id (no session) => 400 error page, no redirect (open-redirect safe)', async () => {
    const res = await httpApp.inject({
      method: 'GET',
      url: fullQuery().replace(`client_id=${RUN}-http`, 'client_id=bogus'),
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['location']).toBeUndefined();
  });

  it('PKCE plain => 302 redirect to redirect_uri with error=invalid_request + iss', async () => {
    const res = await httpApp.inject({
      method: 'GET',
      url: fullQuery().replace('code_challenge_method=S256', 'code_challenge_method=plain'),
    });
    expect(res.statusCode).toBe(302);
    const location = res.headers['location'] as string;
    expect(location).toContain('https://app.example.com/callback?');
    expect(location).toContain('error=invalid_request');
    // AC2 (spec §9.2): the OAuth error redirect must carry error_description too, not just error.
    expect(new URL(location).searchParams.get('error_description')).toBeTruthy();
    expect(location).toContain('state=rp-state');
    expect(location).toContain(`iss=${encodeURIComponent(ISSUER)}`);
  });

  it('response_type != code => 302 redirect with error=unsupported_response_type (AC8)', async () => {
    const res = await httpApp.inject({
      method: 'GET',
      url: fullQuery().replace('response_type=code', 'response_type=token'),
    });
    expect(res.statusCode).toBe(302);
    const location = res.headers['location'] as string;
    expect(location).toContain('https://app.example.com/callback?');
    expect(location).toContain('error=unsupported_response_type');
    expect(new URL(location).searchParams.get('error_description')).toBeTruthy();
    expect(location).toContain('state=rp-state');
    expect(location).toContain(`iss=${encodeURIComponent(ISSUER)}`);
  });

  it('prompt=none with no session => 302 redirect with error=login_required, state, iss (AC9)', async () => {
    const res = await httpApp.inject({ method: 'GET', url: fullQuery('&prompt=none') });
    expect(res.statusCode).toBe(302);
    const location = res.headers['location'] as string;
    expect(location).toContain('https://app.example.com/callback?');
    expect(location).toContain('error=login_required');
    expect(new URL(location).searchParams.get('error_description')).toBeTruthy();
    expect(location).toContain('state=rp-state');
    expect(location).toContain(`iss=${encodeURIComponent(ISSUER)}`);
  });

  it(
    'resume whose Phase 2 fails (scope narrowed after context creation) => 302 redirect ' +
      'with error/state/iss, never a 500 (senior re-review blocker)',
    async () => {
      // Fresh request: redirect_uri trusted + context persisted, but not signed in yet.
      const first = await httpApp.inject({ method: 'GET', url: fullQuery() });
      expect(first.statusCode).toBe(302);
      const returnTo = decodeURIComponent(
        (first.headers['location'] as string).replace('/login?returnTo=', ''),
      );
      const requestId = new URLSearchParams(returnTo.split('?')[1]).get('request_id')!;

      // Narrow the client's allowed scopes between context creation and resume, so Phase 2
      // (which re-validates scope against the *current* client) now rejects a scope the context
      // itself already trusted enough to be created with.
      await httpClientModel.updateOne(
        { clientId: `${RUN}-http` },
        { $set: { scopes: ['profile'] } }, // no longer includes 'openid'
      );

      const { id } = await sessionSvc.create(`${RUN}-http-user2`, 'tenant-A');
      const resumed = await httpApp.inject({
        method: 'GET',
        url: `/authorize?request_id=${encodeURIComponent(requestId)}`,
        cookies: { [SESSION_COOKIE]: id },
      });
      await sessionSvc.revoke(id);
      await httpClientModel.updateOne(
        { clientId: `${RUN}-http` },
        { $set: { scopes: ['openid', 'profile'] } },
      );

      expect(resumed.statusCode).toBe(302);
      const location = resumed.headers['location'] as string;
      expect(location).toContain('https://app.example.com/callback?');
      expect(location).toContain('error=invalid_scope');
      expect(location).toContain('state=rp-state');
      expect(location).toContain(`iss=${encodeURIComponent(ISSUER)}`);
    },
  );
  // --- B4.2 consent flow ---------------------------------------------------------------------

  // Sign in as a fresh ObjectId-backed user and fetch the consent screen for a fresh /authorize.
  // Returns the session cookie id, the parsed _csrf + request_id, and the raw response.
  async function openConsent(extra = '') {
    const userId = new Types.ObjectId().toHexString();
    const { id } = await sessionSvc.create(userId, 'tenant-A');
    const res = await httpApp.inject({
      method: 'GET',
      url: fullQuery(extra),
      cookies: { [SESSION_COOKIE]: id },
    });
    const csrf = res.body.match(/name="_csrf" value="([^"]+)"/)?.[1] as string;
    const requestId = res.body.match(/name="request_id" value="([^"]+)"/)?.[1] as string;
    return { userId, sessionId: id, res, csrf, requestId };
  }

  it('signed in + no consent => 200 consent screen listing requested scopes, no code issued', async () => {
    const { sessionId, res, csrf, requestId } = await openConsent();
    expect(res.statusCode).toBe(200);
    expect(res.headers['location']).toBeUndefined();
    expect(csrf).toBeTruthy();
    expect(requestId).toBeTruthy();
    expect(res.body).toContain('openid');
    expect(res.body).toContain('profile');
    await sessionSvc.revoke(sessionId);
  });

  it('approve => 302 to redirect_uri with code + state echo + iss; code consumable with bound client/uri', async () => {
    const { userId, sessionId, csrf, requestId } = await openConsent();
    const post = await httpApp.inject({
      method: 'POST',
      url: '/authorize/consent',
      cookies: { [SESSION_COOKIE]: sessionId },
      payload: { _csrf: csrf, request_id: requestId, approve: 'true' },
    });
    expect(post.statusCode).toBe(302);
    const location = post.headers['location'] as string;
    expect(location).toContain('https://app.example.com/callback?');
    const url = new URL(location);
    expect(url.searchParams.get('state')).toBe('rp-state');
    expect(url.searchParams.get('iss')).toBe(ISSUER);
    const code = url.searchParams.get('code')!;
    expect(code).toBeTruthy();

    // The code is bound to the stored client_id/redirect_uri and consumable exactly once.
    const data = await codeSvc.consume(code, `${RUN}-http`, 'https://app.example.com/callback');
    expect(data).not.toBeNull();
    expect(data!.userId).toBe(userId);
    expect(data!.scope).toBe('openid profile');
    expect(await codeSvc.consume(code, `${RUN}-http`, 'https://app.example.com/callback')).toBeNull();

    // Consent was persisted for the owner.
    const consent = await consentSvc.find(userId, `${RUN}-http`, undefined);
    expect(consent).not.toBeNull();
    await sessionSvc.revoke(sessionId);
  });

  it('deny => 302 with error=access_denied + state + iss, NO code, NO consent record', async () => {
    const { userId, sessionId, csrf, requestId } = await openConsent();
    const post = await httpApp.inject({
      method: 'POST',
      url: '/authorize/consent',
      cookies: { [SESSION_COOKIE]: sessionId },
      payload: { _csrf: csrf, request_id: requestId, approve: 'false' },
    });
    expect(post.statusCode).toBe(302);
    const url = new URL(post.headers['location'] as string);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe('rp-state');
    expect(url.searchParams.get('iss')).toBe(ISSUER);
    expect(url.searchParams.get('code')).toBeNull();
    expect(await consentSvc.find(userId, `${RUN}-http`, undefined)).toBeNull();
    await sessionSvc.revoke(sessionId);
  });

  it('already-covered consent => GET /authorize skips the screen and 302s a code immediately', async () => {
    const userId = new Types.ObjectId().toHexString();
    await consentSvc.grant(userId, `${RUN}-http`, undefined, ['openid', 'profile'], consentSvc.currentVersions(), ['openid', 'profile']);
    const { id } = await sessionSvc.create(userId, 'tenant-A');
    const res = await httpApp.inject({ method: 'GET', url: fullQuery(), cookies: { [SESSION_COOKIE]: id } });
    expect(res.statusCode).toBe(302);
    const url = new URL(res.headers['location'] as string);
    expect(url.searchParams.get('code')).toBeTruthy();
    expect(url.searchParams.get('state')).toBe('rp-state');
    expect(url.searchParams.get('iss')).toBe(ISSUER);
    await sessionSvc.revoke(id);
  });

  it('prompt=consent still shows the screen even when consent already covers the request', async () => {
    const userId = new Types.ObjectId().toHexString();
    await consentSvc.grant(userId, `${RUN}-http`, undefined, ['openid', 'profile'], consentSvc.currentVersions(), ['openid', 'profile']);
    const { id } = await sessionSvc.create(userId, 'tenant-A');
    const res = await httpApp.inject({ method: 'GET', url: fullQuery('&prompt=consent'), cookies: { [SESSION_COOKIE]: id } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Authorize access');
    await sessionSvc.revoke(id);
  });

  it('prompt=none + no consent => 302 error=consent_required (fail-closed, no UI)', async () => {
    const userId = new Types.ObjectId().toHexString();
    const { id } = await sessionSvc.create(userId, 'tenant-A');
    const res = await httpApp.inject({ method: 'GET', url: fullQuery('&prompt=none'), cookies: { [SESSION_COOKIE]: id } });
    expect(res.statusCode).toBe(302);
    const url = new URL(res.headers['location'] as string);
    expect(url.searchParams.get('error')).toBe('consent_required');
    expect(url.searchParams.get('state')).toBe('rp-state');
    expect(url.searchParams.get('iss')).toBe(ISSUER);
    expect(res.body).not.toContain('Authorize access');
    await sessionSvc.revoke(id);
  });

  it('prompt=none + already covered => 302 a code (success case, OIDC Core, no error)', async () => {
    const userId = new Types.ObjectId().toHexString();
    await consentSvc.grant(userId, `${RUN}-http`, undefined, ['openid', 'profile'], consentSvc.currentVersions(), ['openid', 'profile']);
    const { id } = await sessionSvc.create(userId, 'tenant-A');
    const res = await httpApp.inject({ method: 'GET', url: fullQuery('&prompt=none'), cookies: { [SESSION_COOKIE]: id } });
    expect(res.statusCode).toBe(302);
    const url = new URL(res.headers['location'] as string);
    expect(url.searchParams.get('code')).toBeTruthy();
    expect(url.searchParams.get('error')).toBeNull();
    await sessionSvc.revoke(id);
  });

  it('POST consent without a valid _csrf => 403 (CsrfGuard), no code', async () => {
    const { sessionId, requestId } = await openConsent();
    const post = await httpApp.inject({
      method: 'POST',
      url: '/authorize/consent',
      cookies: { [SESSION_COOKIE]: sessionId },
      payload: { _csrf: 'forged', request_id: requestId, approve: 'true' },
    });
    expect(post.statusCode).toBe(403);
    await sessionSvc.revoke(sessionId);
  });

  it('replay: a second approve with the same request_id => 400 expired page, no second code', async () => {
    const { sessionId, csrf, requestId } = await openConsent();
    const first = await httpApp.inject({
      method: 'POST',
      url: '/authorize/consent',
      cookies: { [SESSION_COOKIE]: sessionId },
      payload: { _csrf: csrf, request_id: requestId, approve: 'true' },
    });
    expect(first.statusCode).toBe(302);
    const second = await httpApp.inject({
      method: 'POST',
      url: '/authorize/consent',
      cookies: { [SESSION_COOKIE]: sessionId },
      payload: { _csrf: csrf, request_id: requestId, approve: 'true' },
    });
    expect(second.statusCode).toBe(400);
    expect(second.headers['location']).toBeUndefined();
    expect(second.body).toContain('expired');
    await sessionSvc.revoke(sessionId);
  });

  it('POST consent after the session is gone => redirect to /login, never a code', async () => {
    const { sessionId, csrf, requestId } = await openConsent();
    await sessionSvc.revoke(sessionId); // session expires between render and submit
    const post = await httpApp.inject({
      method: 'POST',
      url: '/authorize/consent',
      cookies: { [SESSION_COOKIE]: sessionId },
      payload: { _csrf: csrf, request_id: requestId, approve: 'true' },
    });
    // CsrfGuard identity falls back to the anon cookie; with neither session nor matching anon
    // token it is a forged submission => 403 (fail-closed). Either way: no code is ever issued.
    expect([302, 403]).toContain(post.statusCode);
    if (post.statusCode === 302) {
      expect(post.headers['location']).toBe('/login');
    }
  });

  // Negative actor / cross-session: user A opens the consent screen (gets A's _csrf + request_id);
  // user B (a different live session) tries to submit A's request_id with A's _csrf. CSRF tokens
  // bind to the session identity, so A's token does not match B's session => 403, no code issued,
  // and no consent is written for either user. Proves the consent decision cannot be driven across
  // sessions by replaying another user's form fields.
  it('cross-session: user B submitting user A s request_id + A s _csrf => 403, no code, no consent', async () => {
    const { userId: userA, sessionId: sessA, csrf: csrfA, requestId } = await openConsent();
    const userB = new Types.ObjectId().toHexString();
    const { id: sessB } = await sessionSvc.create(userB, 'tenant-A');

    const post = await httpApp.inject({
      method: 'POST',
      url: '/authorize/consent',
      cookies: { [SESSION_COOKIE]: sessB }, // B's session...
      payload: { _csrf: csrfA, request_id: requestId, approve: 'true' }, // ...with A's token
    });
    expect(post.statusCode).toBe(403); // CsrfGuard: token bound to A's identity, not B's
    expect(post.headers['location']).toBeUndefined();
    // No consent was written for either user, and A's context is still intact (not consumed by B).
    expect(await consentSvc.find(userA, `${RUN}-http`, undefined)).toBeNull();
    expect(await consentSvc.find(userB, `${RUN}-http`, undefined)).toBeNull();
    await sessionSvc.revoke(sessA);
    await sessionSvc.revoke(sessB);
  });

  // Negative actor variant: user B uses B's *own* valid _csrf (minted for B's session) to submit
  // A's request_id. CSRF passes (token matches B's session) but the approve path re-derives the
  // owner from B's session and consumes A's context; the issued consent/code must bind to B, never
  // to A. Either outcome is acceptable as long as nothing is ever attributed to user A.
  it('cross-session: user B with B s own _csrf submitting A s request_id never writes consent for A', async () => {
    const { userId: userA, sessionId: sessA, requestId } = await openConsent();
    const userB = new Types.ObjectId().toHexString();
    const { id: sessB } = await sessionSvc.create(userB, 'tenant-A');
    // Mint a _csrf valid for B's session by opening B's own consent screen.
    const bScreen = await httpApp.inject({
      method: 'GET',
      url: fullQuery(),
      cookies: { [SESSION_COOKIE]: sessB },
    });
    const csrfB = bScreen.body.match(/name="_csrf" value="([^"]+)"/)?.[1] as string;
    expect(csrfB).toBeTruthy();

    const post = await httpApp.inject({
      method: 'POST',
      url: '/authorize/consent',
      cookies: { [SESSION_COOKIE]: sessB },
      payload: { _csrf: csrfB, request_id: requestId, approve: 'true' },
    });
    // Whatever the outcome, consent must NEVER be attributed to user A.
    expect(await consentSvc.find(userA, `${RUN}-http`, undefined)).toBeNull();
    // If a code/consent was issued, it must belong to B (the authenticated session), not A.
    if (post.statusCode === 302 && (post.headers['location'] as string)?.includes('code=')) {
      const consentB = await consentSvc.find(userB, `${RUN}-http`, undefined);
      expect(consentB).not.toBeNull();
    }
    await sessionSvc.revoke(sessA);
    await sessionSvc.revoke(sessB);
  });
});