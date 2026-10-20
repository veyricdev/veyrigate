import { jest } from '@jest/globals';
import { Controller, Get, Module, Param, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import cookie from '@fastify/cookie';
import view from '@fastify/view';
import { Eta } from 'eta';
import IORedis from 'ioredis';
import { Types, type Connection, type Model } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Counter } from 'prom-client';
import { registerMetrics } from '../src/common/metrics/metrics.http';
import { AdminClientsController } from '../src/modules/admin/admin-clients.controller';
import { AdminUsersController } from '../src/modules/admin/admin-users.controller';
import { connect as netConnect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { deriveS256Challenge } from '../src/common/crypto/pkce.util';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { RedisService } from '../src/database/redis/redis.service';
import { AuthenticationService } from '../src/modules/authentication/authentication.service';
import {
  ClientAuthRateLimitedError,
  ClientAuthenticationService,
} from '../src/modules/clients/client-authentication.service';
import { ClientCorsService } from '../src/modules/clients/client-cors.service';
import { ClientCredentialService } from '../src/modules/clients/client-credential.service';
import { ClientService, type Client } from '../src/modules/clients/client.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { UserTenantService } from '../src/modules/identity/user-tenant.service';
import { ADMIN_LOCKED_UNTIL, UserService } from '../src/modules/identity/user.service';
import { KEY_PROVIDER } from '../src/modules/keys/key-provider';
import { KeyRotationService } from '../src/modules/keys/key-rotation.service';
import { LocalKeyProvider } from '../src/modules/keys/local-key-provider';
import { TokenSigner } from '../src/modules/keys/token-signer';
import { TokenVerifier } from '../src/modules/keys/token-verifier';
import { MAILER } from '../src/modules/mailer/mailer';
import { AuthorizeController } from '../src/modules/oauth/authorize/authorize.controller';
import { AuthorizeRequestContextService } from '../src/modules/oauth/authorize/authorize-request-context.service';
import { AuthorizeService } from '../src/modules/oauth/authorize/authorize.service';
import { AuthorizationCodeService } from '../src/modules/oauth/code/authorization-code.service';
import { ConsentService } from '../src/modules/oauth/consent/consent.service';
import { RefreshTokenService } from '../src/modules/oauth/token/refresh-token.service';
import { TokenController } from '../src/modules/oauth/token/token.controller';
import { TokenService } from '../src/modules/oauth/token/token.service';
import { ResourceService } from '../src/modules/resources/resource.service';
import { AuditAction } from '../src/modules/security/audit/audit-action.enum';
import { AuditService } from '../src/modules/security/audit/audit.service';
import type { AuditEvent } from '../src/modules/security/audit/audit.types';
import { RateLimitService } from '../src/modules/security/rate-limit/rate-limit.service';
import { SESSION_COOKIE, SessionCookie } from '../src/modules/sessions/session.cookie';
import { SessionService } from '../src/modules/sessions/session.service';
import { CsrfGuard, CsrfService } from '../src/modules/ui/csrf.service';
import { HtmlExceptionFilter } from '../src/modules/ui/html-exception.filter';
import { seedConsent, seedOAuthUser } from './oauth-fixtures';

const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-metrics-${Date.now()}?directConnection=true`;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';
const RUN = `mt${Date.now()}`;
const ISSUER = 'http://localhost:4000';
const REDIRECT = 'https://app.example.com/callback';
const RESOURCE = 'https://api.example.com/';
const SCOPE = 'openid offline_access api.read';
const TENANT = 'tenant-M';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = deriveS256Challenge(VERIFIER);
// Random per run, never printed (a 64-char hex value satisfies METRICS_TOKEN min(32)).
const METRICS_TOKEN = randomBytes(32).toString('hex');

const cfg = {
  getOrThrow: (ns: string) => {
    if (ns === 'app') return { nodeEnv: 'production', issuer: ISSUER };
    if (ns === 'session') return { cookieSecure: false };
    if (ns === 'token')
      return {
        accessTokenTtl: 900,
        refreshTokenTtl: 2592000,
        sessionIdleTtl: 3600,
        sessionAbsoluteTtl: 86400,
      };
    if (ns === 'client') return { secretGraceTtl: 60 };
    if (ns === 'consent') return { policyVersion: '1', termsVersion: '1' };
    if (ns === 'security')
      return {
        csrfSecret: 'test-csrf-secret',
        rateLimitWindow: 60,
        rateLimitMax: 100000,
        clientAuthFailIpMax: 100000,
        clientAuthFailClientMax: 100000,
      };
    throw new Error(`Unexpected config namespace: ${ns}`);
  },
} as unknown as ConfigService;

/** A parameterised Nest route to prove the `route` label is the TEMPLATE, never the raw path. */
@Controller('probe')
class ProbeController {
  @Get(':id')
  get(@Param('id') id: string) {
    return { ok: id.length > 0 };
  }
}

/** `name{k="v",...} value` lines of a text exposition => value of the series matching `labels`. */
function sample(text: string, name: string, labels: Record<string, string>): number | undefined {
  for (const line of text.split('\n')) {
    const m = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})? (\S+)$/.exec(line);
    if (!m || m[1] !== name) continue;
    const got = Object.fromEntries(
      [...(m[2] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map((p) => [p[1], p[2]]),
    );
    if (Object.entries(labels).every(([k, v]) => got[k] === v)) return Number(m[3]);
  }
  return undefined;
}

describe('Prometheus /metrics + business metrics (B7.2)', () => {
  let app: NestFastifyApplication;
  let redis: IORedis;
  let keyDir: string;
  let conn: Connection;
  let clientModel: Model<Client>;
  let auditModel: Model<AuditEvent>;
  let refreshModel: Model<Record<string, unknown>>;
  let refresh: RefreshTokenService;
  let seq = 0;

  const scrape = async (): Promise<string> => {
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    return res.body;
  };
  const audits = async (action: AuditAction, result: 'success' | 'failure') =>
    sample(await scrape(), 'sso_audit_events_total', { action, result });
  const tokenErrors = async (error: string, endpoint = 'token') =>
    sample(await scrape(), 'sso_token_endpoint_errors_total', { endpoint, error });

  async function mkClient(): Promise<string> {
    const clientId = `${RUN}-c${++seq}`;
    await new ClientService(clientModel, cfg).create({
      clientId,
      clientType: 'public',
      tokenEndpointAuthMethod: 'none',
      redirectUris: [REDIRECT],
      allowedResources: ['api'],
      scopes: ['openid', 'offline_access', 'api.read'],
      grantTypes: ['authorization_code', 'refresh_token'],
      tenantId: TENANT,
    });
    return clientId;
  }

  async function issueCode(): Promise<{ clientId: string; userId: string; code: string }> {
    const clientId = await mkClient();
    const userId = await seedOAuthUser(conn, { tenantId: TENANT });
    await seedConsent(conn, { userId, clientId, resource: RESOURCE, scopes: SCOPE.split(' ') });
    const { id } = await app.get(SessionService).create(userId, DEFAULT_TENANT_ID);
    const res = await app.inject({
      method: 'GET',
      url: `/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        scope: SCOPE,
        resource: RESOURCE,
        state: 'rp-state',
        nonce: 'rp-nonce',
        code_challenge: CHALLENGE,
        code_challenge_method: 'S256',
      }).toString()}`,
      cookies: { [SESSION_COOKIE]: id },
    });
    expect(res.statusCode).toBe(302);
    const code = new URL(res.headers['location'] as string).searchParams.get('code');
    return { clientId, userId, code: code! };
  }

  const exchange = (clientId: string, code: string) =>
    app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      }).toString(),
    });

  const refreshReq = (clientId: string, rt: string, remoteAddress?: string) =>
    app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      ...(remoteAddress ? { remoteAddress } : {}),
      payload: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: rt,
      }).toString(),
    });

  async function firstRefresh(): Promise<{ clientId: string; userId: string; rt: string }> {
    const { clientId, userId, code } = await issueCode();
    const res = await exchange(clientId, code);
    expect(res.statusCode).toBe(200);
    return { clientId, userId, rt: res.json().refresh_token as string };
  }

  beforeAll(async () => {
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    keyDir = await mkdtemp(join(tmpdir(), 'vg-metrics-int-'));
    const provider = new LocalKeyProvider(keyDir);
    await provider.init();
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(MONGO_URI, {
          serverSelectionTimeoutMS: 5000,
          retryAttempts: 5,
          retryDelay: 1000,
        }),
        MongooseModule.forFeature(MODELS),
      ],
      controllers: [
        AuthorizeController,
        TokenController,
        ProbeController,
        // run 37 tester: real admin routes with ids, to prove ids never reach the route label.
        AdminClientsController,
        AdminUsersController,
      ],
      providers: [
        AuthorizeService,
        AuthorizeRequestContextService,
        AuthorizationCodeService,
        AuthenticationService,
        ConsentService,
        CsrfService,
        CsrfGuard,
        TokenService,
        RefreshTokenService,
        ClientService,
        ClientCredentialService,
        ClientAuthenticationService,
        ClientCorsService,
        UserService,
        UserTenantService,
        ResourceService,
        SessionService,
        SessionCookie,
        AuditService,
        RateLimitService,
        KeyRotationService,
        TokenSigner,
        TokenVerifier,
        HtmlExceptionFilter,
        { provide: KEY_PROVIDER, useValue: provider },
        { provide: MAILER, useValue: { send: async () => undefined } },
        { provide: RedisService, useValue: new RedisService(redis) },
        { provide: ConfigService, useValue: cfg },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // The production wiring (same function `configureApp` calls), before Nest adds its routes.
    registerMetrics(app.getHttpAdapter().getInstance(), { token: METRICS_TOKEN });
    await app.register(cookie);
    await app.register(view, {
      engine: { eta: new Eta({ views: join(process.cwd(), 'src/views'), autoEscape: true }) },
      root: join(process.cwd(), 'src/views'),
      layout: 'layout.eta',
    });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    clientModel = app.get<Model<Client>>(getModelToken('Client'));
    conn = clientModel.db;
    await syncAllIndexes(conn);
    auditModel = app.get<Model<AuditEvent>>(getModelToken('AuditLog'));
    refreshModel = app.get<Model<Record<string, unknown>>>(getModelToken('RefreshToken'));
    refresh = app.get(RefreshTokenService);
    await app
      .get(ResourceService)
      .create({ resourceId: 'api', identifier: RESOURCE, scopes: ['api.read'] });
  }, 60_000);

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    if (conn) await conn.dropDatabase();
    if (app) await app.close();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  // ---- M7 "alert fires": first so the selected series are still at their initial 0 (M4).
  describe('alert series go 0 -> 1 on the real event', () => {
    it('replay of a ROTATED refresh token => TOKEN_REUSE_DETECTED/failure 0 -> 1', async () => {
      const { clientId, rt } = await firstRefresh();
      expect((await refreshReq(clientId, rt)).statusCode).toBe(200);
      expect(await audits(AuditAction.TOKEN_REUSE_DETECTED, 'failure')).toBe(0);
      const replay = await refreshReq(clientId, rt);
      expect(replay.json().error).toBe('invalid_grant');
      expect(await audits(AuditAction.TOKEN_REUSE_DETECTED, 'failure')).toBe(1);
    });

    it('emergency key rotation => sso_signing_key_rotations_total{emergency,success} 0 -> 1', async () => {
      const series = { mode: 'emergency', result: 'success' };
      expect(sample(await scrape(), 'sso_signing_key_rotations_total', series)).toBe(0);
      await app
        .get(KeyRotationService)
        .rotate('emergency', { actorType: 'admin', actorId: 'metrics-int' });
      const text = await scrape();
      expect(sample(text, 'sso_signing_key_rotations_total', series)).toBe(1);
      expect(sample(text, 'sso_signing_key_rotations_total', { ...series, mode: 'normal' })).toBe(
        0,
      );
      expect(
        sample(text, 'sso_audit_events_total', {
          action: AuditAction.SIGNING_KEY_ROTATED,
          result: 'success',
        }),
      ).toBe(1);
    });
  });

  // ---- Task 1 / M6: access control of /metrics.
  describe('GET /metrics access (M6)', () => {
    it('correct bearer => 200, Prometheus text exposition, no-store', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: `Bearer ${METRICS_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.headers['content-type']).toContain('version=0.0.4');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toContain('# TYPE sso_audit_events_total counter');
      expect(res.body).toContain('# TYPE sso_http_request_duration_seconds histogram');
      expect(res.body).toContain('process_cpu_user_seconds_total');
    });

    it.each([
      ['no Authorization header', {}, ''],
      ['wrong token of the same length', { authorization: `Bearer ${'0'.repeat(64)}` }, ''],
      ['correct token in the query string only', {}, `?token=${METRICS_TOKEN}`],
      [
        'Basic scheme',
        { authorization: `Basic ${Buffer.from(`x:${METRICS_TOKEN}`).toString('base64')}` },
        '',
      ],
      ['bearer with a trailing extra value', { authorization: `Bearer ${METRICS_TOKEN} x` }, ''],
    ])('%s => 401, WWW-Authenticate: Bearer, empty body', async (_n, headers, query) => {
      const res = await app.inject({ method: 'GET', url: `/metrics${query}`, headers });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.body).toBe('');
      expect(res.body).not.toContain('sso_');
    });

    it('registry failure => 500 with an empty body (no stack/details)', async () => {
      const { registry } = await import('../src/common/metrics/metrics');
      jest.spyOn(registry, 'metrics').mockRejectedValueOnce(new Error('boom secret-detail'));
      const res = await app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: `Bearer ${METRICS_TOKEN}` },
      });
      expect(res.statusCode).toBe(500);
      expect(res.body).toBe('');
    });
  });

  describe('route label (M6 test 3)', () => {
    it('a parameterised route is labelled by its template; an unknown path by __unmatched', async () => {
      const id = new Types.ObjectId().toHexString();
      const unknown = `khong-ton-tai-${randomUUID()}`;
      expect((await app.inject({ method: 'GET', url: `/probe/${id}` })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: `/${unknown}` })).statusCode).toBe(404);
      const text = await scrape();
      expect(
        sample(text, 'sso_http_request_duration_seconds_count', {
          method: 'GET',
          route: '/probe/:id',
          status_class: '2xx',
        }),
      ).toBeGreaterThanOrEqual(1);
      expect(
        sample(text, 'sso_http_request_duration_seconds_count', {
          method: 'GET',
          route: '__unmatched',
          status_class: '4xx',
        }),
      ).toBeGreaterThanOrEqual(1);
      expect(text).not.toContain(id);
      expect(text).not.toContain(unknown);
    });
  });

  describe('exposure (M6 test 4)', () => {
    it('after a failed login and a refresh, /metrics carries no email, clientId, IP, user, RT or family', async () => {
      const email = `metrics-leak-${RUN}@probe.test`;
      await expect(
        app.get(AuthenticationService).login(email, 'wrong-password-123', { ip: '198.51.100.23' }),
      ).rejects.toThrow();
      const { clientId, userId, rt } = await firstRefresh();
      const ip = '203.0.113.77';
      const res = await refreshReq(clientId, rt, ip);
      expect(res.statusCode).toBe(200);
      const docs = await refreshModel.find({ userId: new Types.ObjectId(userId) }).lean();
      const familyId = String(docs[0].familyId);
      const text = await scrape();
      for (const s of [
        email,
        clientId,
        RUN,
        ip,
        '198.51.100.23',
        userId,
        rt,
        res.json().refresh_token,
        familyId,
        TENANT,
      ]) {
        expect(text).not.toContain(s);
      }
    });
  });

  // ---- Task 2 / M2bis: each path moves exactly its counter.
  describe('business counters (M2bis)', () => {
    it('code grant 200 => TOKEN_ISSUED/success +1', async () => {
      const { clientId, code } = await issueCode();
      const before = await audits(AuditAction.TOKEN_ISSUED, 'success');
      expect((await exchange(clientId, code)).statusCode).toBe(200);
      expect(await audits(AuditAction.TOKEN_ISSUED, 'success')).toBe(before! + 1);
    });

    it('refresh 200 => TOKEN_REFRESHED/success +1, TOKEN_ISSUED/success +0', async () => {
      const { clientId, rt } = await firstRefresh();
      const issued = await audits(AuditAction.TOKEN_ISSUED, 'success');
      const refreshed = await audits(AuditAction.TOKEN_REFRESHED, 'success');
      expect((await refreshReq(clientId, rt)).statusCode).toBe(200);
      expect(await audits(AuditAction.TOKEN_ISSUED, 'success')).toBe(issued);
      expect(await audits(AuditAction.TOKEN_REFRESHED, 'success')).toBe(refreshed! + 1);
    });

    it('refresh refused (admin lock after rotate) => TOKEN_REFRESHED/failure +1, success +0, invalid_grant +1', async () => {
      const { clientId, rt } = await firstRefresh();
      const original = refresh.rotate.bind(refresh);
      jest
        .spyOn(refresh, 'rotate')
        .mockImplementationOnce(async (...args: Parameters<RefreshTokenService['rotate']>) => {
          const out = await original(...args);
          await conn
            .model('User')
            .updateOne(
              { _id: new Types.ObjectId(out.userId) },
              { $set: { lockedUntil: ADMIN_LOCKED_UNTIL } },
            );
          return out;
        });
      const failure = await audits(AuditAction.TOKEN_REFRESHED, 'failure');
      const success = await audits(AuditAction.TOKEN_REFRESHED, 'success');
      const grantErr = await tokenErrors('invalid_grant');
      const res = await refreshReq(clientId, rt);
      expect(res.json().error).toBe('invalid_grant');
      expect(await audits(AuditAction.TOKEN_REFRESHED, 'failure')).toBe(failure! + 1);
      expect(await audits(AuditAction.TOKEN_REFRESHED, 'success')).toBe(success);
      expect(await tokenErrors('invalid_grant')).toBe(grantErr! + 1);
    });

    it('bogus code => sso_token_endpoint_errors_total{token,invalid_grant} +1 and nothing on revoke', async () => {
      const clientId = await mkClient();
      const before = await tokenErrors('invalid_grant');
      const revokeBefore = await tokenErrors('invalid_grant', 'revoke');
      const res = await exchange(clientId, 'bogus-code');
      expect(res.json().error).toBe('invalid_grant');
      expect(await tokenErrors('invalid_grant')).toBe(before! + 1);
      expect(await tokenErrors('invalid_grant', 'revoke')).toBe(revokeBefore);
    });

    it('/revoke error => counted under endpoint="revoke"', async () => {
      const before = await tokenErrors('invalid_request', 'revoke');
      const res = await app.inject({
        method: 'POST',
        url: '/revoke',
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(res.json().error).toBe('invalid_request');
      expect(await tokenErrors('invalid_request', 'revoke')).toBe(before! + 1);
    });

    it('client-auth rate limit 429 => temporarily_unavailable +1', async () => {
      const clientId = await mkClient();
      jest
        .spyOn(app.get(ClientAuthenticationService), 'authenticate')
        .mockRejectedValueOnce(new ClientAuthRateLimitedError(30));
      const before = await tokenErrors('temporarily_unavailable');
      const res = await exchange(clientId, 'whatever');
      expect(res.statusCode).toBe(429);
      expect(await tokenErrors('temporarily_unavailable')).toBe(before! + 1);
    });

    it('failed login => AUTH_LOGIN_FAILED/failure +1', async () => {
      const before = await audits(AuditAction.AUTH_LOGIN_FAILED, 'failure');
      await expect(
        app.get(AuthenticationService).login(`nobody-${RUN}@probe.test`, 'wrong-password-123', {}),
      ).rejects.toThrow();
      expect(await audits(AuditAction.AUTH_LOGIN_FAILED, 'failure')).toBe(before! + 1);
    });

    it('audit write fails => counter +0 (counters match persisted audit only)', async () => {
      const before = await audits(AuditAction.TOKEN_REVOKED, 'success');
      jest.spyOn(auditModel, 'create').mockRejectedValueOnce(new Error('mongo down') as never);
      await expect(
        app.get(AuditService).record({
          actorType: 'system',
          action: AuditAction.TOKEN_REVOKED,
          result: 'success',
        }),
      ).rejects.toThrow('mongo down');
      expect(await audits(AuditAction.TOKEN_REVOKED, 'success')).toBe(before);
    });

    it('observeAuditEvent throwing never breaks the request: code grant still 200 with tokens', async () => {
      const { clientId, userId, code } = await issueCode();
      const { registry } = await import('../src/common/metrics/metrics');
      const counter = registry.getSingleMetric('sso_audit_events_total') as Counter;
      const inc = jest.spyOn(counter, 'inc').mockImplementation(() => {
        throw new Error('metrics broken');
      });
      const res = await exchange(clientId, code);
      expect(inc).toHaveBeenCalled();
      jest.restoreAllMocks();
      expect(res.statusCode).toBe(200);
      expect(res.json().refresh_token).toBeTruthy();
      const issued = await auditModel
        .find({ action: AuditAction.TOKEN_ISSUED, actorId: userId })
        .lean();
      expect(issued).toHaveLength(1);
    });
  });
  // ---- run 37 tester: risk matrix (credential shape, request framing, cardinality, per-action).
  describe('tester risk matrix (run 37)', () => {
    const get = (headers: Record<string, string | string[]>) =>
      app.inject({ method: 'GET', url: '/metrics', headers: headers as Record<string, string> });

    it.each([
      ['token one char shorter', () => `Bearer ${METRICS_TOKEN.slice(0, -1)}`],
      ['token one char longer', () => `Bearer ${METRICS_TOKEN}0`],
      ['32-char prefix of the token', () => `Bearer ${METRICS_TOKEN.slice(0, 32)}`],
      ['empty token', () => 'Bearer '],
      ['scheme only', () => 'Bearer'],
      ['double space before the token', () => `Bearer  ${METRICS_TOKEN}`],
      [
        'token upper-cased (token is case-sensitive)',
        () => `Bearer ${METRICS_TOKEN.toUpperCase()}`,
      ],
      ['other scheme name', () => `Token ${METRICS_TOKEN}`],
      ['scheme glued to the token', () => `Bearer${METRICS_TOKEN}`],
      ['tab instead of space', () => `Bearer\t${METRICS_TOKEN}`],
    ])('credential: %s => 401, empty body', async (_n, value) => {
      const res = await get({ authorization: value() });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.body).toBe('');
    });

    it.each(['bearer', 'BEARER', 'bEaReR'])(
      'auth scheme is case-insensitive (RFC 9110 11.1): "%s <token>" => 200',
      async (scheme) => {
        const res = await get({ authorization: `${scheme} ${METRICS_TOKEN}` });
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('# TYPE sso_audit_events_total counter');
      },
    );

    it('Authorization given as an array (two values) => 401', async () => {
      const res = await get({
        authorization: [`Bearer ${METRICS_TOKEN}`, `Bearer ${METRICS_TOKEN}`],
      });
      expect(res.statusCode).toBe(401);
      expect(res.body).toBe('');
    });

    describe('real socket (header framing parsed by Node itself)', () => {
      let port: number;
      beforeAll(async () => {
        await app.listen(0, '127.0.0.1');
        port = (app.getHttpServer().address() as AddressInfo).port;
      });

      /** Raw HTTP/1.1 exchange => status code + raw response text. */
      const raw = (head: string): Promise<{ status: number; text: string }> =>
        new Promise((resolve, reject) => {
          const sock = netConnect(port, '127.0.0.1');
          let buf = '';
          sock.setEncoding('utf8');
          sock.on('data', (d: string) => (buf += d));
          sock.on('error', reject);
          sock.on('end', () =>
            resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] ?? 0), text: buf }),
          );
          sock.write(`${head}Host: 127.0.0.1\r\nConnection: close\r\n\r\n`);
        });

      it('duplicate Authorization headers, wrong one first => 401 (Node keeps the first)', async () => {
        const res = await raw(
          `GET /metrics HTTP/1.1\r\nAuthorization: Bearer ${'f'.repeat(64)}\r\nAuthorization: Bearer ${METRICS_TOKEN}\r\n`,
        );
        expect(res.status).toBe(401);
        expect(res.text).not.toContain('sso_audit_events_total');
      });

      it('duplicate Authorization headers, right one first => 200 (caller still holds the token)', async () => {
        const res = await raw(
          `GET /metrics HTTP/1.1\r\nAuthorization: Bearer ${METRICS_TOKEN}\r\nAuthorization: Bearer ${'f'.repeat(64)}\r\n`,
        );
        expect(res.status).toBe(200);
      });

      it('DEBT-222: a method outside the fixed set is labelled OTHER (never the raw method)', async () => {
        const res = await raw('PROPFIND /probe/x HTTP/1.1\r\n');
        expect(res.status).toBeGreaterThanOrEqual(400);
        const text = await scrape();
        expect(text).toMatch(/sso_http_request_duration_seconds_count\{[^}]*method="OTHER"/);
        expect(text).not.toContain('PROPFIND');
      });
    });

    it('real admin routes with ids are labelled by template; ids never appear', async () => {
      const clientId = await mkClient();
      const userId = new Types.ObjectId().toHexString();
      const familyId = randomUUID();
      const r1 = await app.inject({ method: 'GET', url: `/admin/clients/${clientId}` });
      const r2 = await app.inject({ method: 'GET', url: `/admin/users/${userId}?x=${RUN}` });
      const r3 = await app.inject({
        method: 'POST',
        url: `/admin/users/${userId}/families/${familyId}/revoke`,
      });
      for (const r of [r1, r2, r3]) expect(r.statusCode).toBe(401);
      const text = await scrape();
      for (const route of [
        '/admin/clients/:clientId',
        '/admin/users/:id',
        '/admin/users/:id/families/:familyId/revoke',
      ]) {
        expect(text).toContain(`route="${route}"`);
      }
      for (const s of [clientId, RUN, userId, familyId]) expect(text).not.toContain(s);
    });

    it('cardinality: a second batch of requests with fresh random ids/paths/queries adds no series', async () => {
      const seriesOf = (text: string) =>
        new Set(
          text
            .split('\n')
            .filter((l) => l.startsWith('sso_http_request_duration_seconds_count{'))
            .map((l) => l.slice(0, l.lastIndexOf(' '))),
        );
      const batch = async () => {
        for (let i = 0; i < 25; i++) {
          const id = new Types.ObjectId().toHexString();
          const u = randomUUID();
          await app.inject({ method: 'GET', url: `/probe/${u}?q=${id}` });
          await app.inject({ method: 'GET', url: `/admin/users/${id}` });
          await app.inject({ method: 'DELETE', url: `/admin/clients/${u}/secrets/${i + 1}` });
          await app.inject({ method: 'GET', url: `/nope/${u}/${id}` });
          await app.inject({ method: 'POST', url: `/x-${u}` });
        }
      };
      await batch();
      const first = seriesOf(await scrape());
      await batch();
      const second = seriesOf(await scrape());
      expect([...second].filter((s) => !first.has(s))).toEqual([]);
      for (const s of second) {
        expect(s).toMatch(/route="(\/[\w/:.-]*|__unmatched)"/);
        expect(s).not.toMatch(/[0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-/);
      }
      // Bounded: method x route template x status class only.
      expect(second.size).toBeLessThan(60);
    });

    it('every AuditAction persisted via AuditService.record => exactly +1 on its own series, 0 elsewhere', async () => {
      const allAudit = async () => {
        const out = new Map<string, number>();
        for (const line of (await scrape()).split('\n')) {
          const m = /^sso_audit_events_total\{(.*)\} (\S+)$/.exec(line);
          if (m) out.set(m[1], Number(m[2]));
        }
        return out;
      };
      for (const action of Object.values(AuditAction)) {
        for (const result of ['success', 'failure'] as const) {
          const before = await allAudit();
          await app.get(AuditService).record({ actorType: 'system', action, result });
          const after = await allAudit();
          const key = `action="${action}",result="${result}"`;
          expect(after.get(key)).toBe(before.get(key)! + 1);
          expect(after.size).toBe(before.size);
          for (const [k, v] of after) if (k !== key) expect([k, v]).toEqual([k, before.get(k)]);
        }
      }
    });

    it('normal key rotation => rotations{normal,success} +1, emergency +0', async () => {
      const n = { mode: 'normal', result: 'success' };
      const e = { mode: 'emergency', result: 'success' };
      const before = await scrape();
      await app
        .get(KeyRotationService)
        .rotate('normal', { actorType: 'admin', actorId: 'metrics-int' });
      const after = await scrape();
      expect(sample(after, 'sso_signing_key_rotations_total', n)).toBe(
        sample(before, 'sso_signing_key_rotations_total', n)! + 1,
      );
      expect(sample(after, 'sso_signing_key_rotations_total', e)).toBe(
        sample(before, 'sso_signing_key_rotations_total', e),
      );
    });
  });
});

// M6 test 1: METRICS_TOKEN unset => the route does not exist (404), the latency hook still runs.
describe('GET /metrics without METRICS_TOKEN (M6)', () => {
  @Module({})
  class EmptyModule {}

  let app: NestFastifyApplication;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [EmptyModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerMetrics(app.getHttpAdapter().getInstance(), { token: undefined });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    if (app) await app.close();
  });

  it('404 with or without a bearer', async () => {
    for (const headers of [{}, { authorization: `Bearer ${METRICS_TOKEN}` }]) {
      const res = await app.inject({ method: 'GET', url: '/metrics', headers });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('sso_');
    }
  });
});
