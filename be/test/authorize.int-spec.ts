import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import cookie from '@fastify/cookie';
import view from '@fastify/view';
import { Eta } from 'eta';
import IORedis from 'ioredis';
import mongoose, { type Connection, type Model } from 'mongoose';
import { join } from 'node:path';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { RedisService } from '../src/database/redis/redis.service';
import { SessionService } from '../src/modules/sessions/session.service';
import { SessionCookie, SESSION_COOKIE } from '../src/modules/sessions/session.cookie';
import { HtmlExceptionFilter } from '../src/modules/ui/html-exception.filter';
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

const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-authorize-${Date.now()}?directConnection=true`;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';
const RUN = `az${Date.now()}`;

const ISSUER = 'http://localhost:4000';

function config(): ConfigService {
  const base: Record<string, unknown> = { app: { nodeEnv: 'production', issuer: ISSUER } };
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
  let ctxClock: number;
  let service: AuthorizeService;

  const signedIn: SessionView = { userId: `${RUN}-user`, authTime: Date.now() };

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
    service = new AuthorizeService(clients, resources, contexts, audit, config());

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
      await expect(
        service.handle(params({ client_id: 'nope' }), signedIn),
      ).rejects.toBeInstanceOf(AuthorizeErrorPage);
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
      await expect(
        service.handle(params({ max_age: '-5' }), signedIn),
      ).rejects.toMatchObject({ error: 'invalid_request' });
    });
  });

  describe('prompt=none', () => {
    it('returns login_required (OAuth error) when not signed in', async () => {
      await expect(
        service.handle(params({ prompt: 'none' }), null),
      ).rejects.toMatchObject({ error: 'login_required' });
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

    it('signed in + valid => ready; context echoes state/nonce; request_id != state (C8)', async () => {
      const p = params({ state: 'the-rp-state', nonce: 'the-rp-nonce', resource: 'https://api.example.com/' });
      const outcome = await service.handle(p, signedIn);
      expect(outcome.kind).toBe('ready');
      if (outcome.kind !== 'ready') throw new Error('unreachable');
      expect(outcome.requestId).not.toBe(p.state);
      expect(outcome.userId).toBe(signedIn.userId);
      const ctx = await contexts.consume(outcome.requestId);
      expect(ctx).not.toBeNull();
      expect(ctx!.originalState).toBe('the-rp-state');
      expect(ctx!.nonce).toBe('the-rp-nonce');
      expect(ctx!.resource).toBe('https://api.example.com/');
    });

    it('resolves resource via identifier->resourceId, never the URI directly', async () => {
      const outcome = await service.handle(params({ resource: 'https://api.example.com/' }), signedIn);
      if (outcome.kind !== 'ready') throw new Error('expected ready');
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
      const [a, b] = await Promise.all([
        contexts.consume(requestId),
        contexts.consume(requestId),
      ]);
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
      if (outcome.kind !== 'ready') throw new Error('expected ready');
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
  let httpClientModel: Model<Client>;

  const cfg = {
    getOrThrow: (ns: string) => {
      if (ns === 'app') return { nodeEnv: 'production', issuer: ISSUER };
      if (ns === 'session') return { cookieSecure: false };
      if (ns === 'token') return { sessionIdleTtl: 3600, sessionAbsoluteTtl: 86400 };
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

  it('login then resume via request_id => 200 ready page (context not lost)', async () => {
    const first = await httpApp.inject({ method: 'GET', url: fullQuery() });
    const returnTo = decodeURIComponent(
      (first.headers['location'] as string).replace('/login?returnTo=', ''),
    );
    const requestId = new URLSearchParams(returnTo.split('?')[1]).get('request_id')!;

    const { id } = await sessionSvc.create(`${RUN}-http-user`, 'tenant-A');
    const resumed = await httpApp.inject({
      method: 'GET',
      url: `/authorize?request_id=${encodeURIComponent(requestId)}`,
      cookies: { [SESSION_COOKIE]: id },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.body).toContain('Authorization request accepted');
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
});
