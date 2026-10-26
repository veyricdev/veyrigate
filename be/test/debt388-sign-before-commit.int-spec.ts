import { jest } from '@jest/globals';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import cookie from '@fastify/cookie';
import view from '@fastify/view';
import { Eta } from 'eta';
import IORedis from 'ioredis';
import { Types, type Connection, type Model } from 'mongoose';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../src/common/crypto/crypto.util';
import { deriveS256Challenge } from '../src/common/crypto/pkce.util';
import { KeyProviderUnavailableError } from '../src/common/errors/dependency-unavailable';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { RedisService } from '../src/database/redis/redis.service';
import { ClientAuthenticationService } from '../src/modules/clients/client-authentication.service';
import { ClientCorsService } from '../src/modules/clients/client-cors.service';
import { ClientCredentialService } from '../src/modules/clients/client-credential.service';
import { ClientService, type Client } from '../src/modules/clients/client.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { UserTenantService } from '../src/modules/identity/user-tenant.service';
import { UserService } from '../src/modules/identity/user.service';
import { KEY_PROVIDER } from '../src/modules/keys/key-provider';
import { LocalKeyProvider } from '../src/modules/keys/local-key-provider';
import { TokenSigner, type SignOptions } from '../src/modules/keys/token-signer';
import { TokenVerifier } from '../src/modules/keys/token-verifier';
import { AuthorizeController } from '../src/modules/oauth/authorize/authorize.controller';
import { AuthorizeRequestContextService } from '../src/modules/oauth/authorize/authorize-request-context.service';
import { AuthorizeService } from '../src/modules/oauth/authorize/authorize.service';
import { AuthorizationCodeService } from '../src/modules/oauth/code/authorization-code.service';
import { ConsentService } from '../src/modules/oauth/consent/consent.service';
import { RefreshTokenService } from '../src/modules/oauth/token/refresh-token.service';
import { TokenController } from '../src/modules/oauth/token/token.controller';
import { TokenService, adminResourceIdentifier } from '../src/modules/oauth/token/token.service';
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
  `mongodb://localhost:27117/vg-int-debt388-${Date.now()}?directConnection=true`;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';
const RUN = `d388${Date.now()}`;
const ISSUER = 'http://localhost:4000';
const ADMIN = adminResourceIdentifier(ISSUER);
const REDIRECT = 'https://app.example.com/callback';
const RESOURCE = 'https://api.example.com/';
const SCOPE = 'openid offline_access api.read';
const TENANT = 'tenant-B';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const WRONG_VERIFIER = 'x'.repeat(43);
const CHALLENGE = deriveS256Challenge(VERIFIER);
const OUTAGE = {
  error: 'temporarily_unavailable',
  error_description: 'The service is temporarily unavailable. Try again later.',
};

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

type Res = { statusCode: number; body: string; headers: Record<string, unknown> };

/**
 * DEBT-388 (run 54): `/token` signs BEFORE the irreversible commit (code consume / RT rotate), so a
 * signing failure changes no state (I4) and a retry is never reuse; single-use (I1), one usable
 * successor (I2), "token only leaves on a won commit + passed re-checks" (I3) and reuse detection
 * after a committed rotation (I5) still hold. Signing faults are injected on `TokenSigner.sign`;
 * races use a barrier held right after the access-token signature (before consume/rotate).
 */
describe('DEBT-388: sign before commit (/token code + refresh grants)', () => {
  let app: NestFastifyApplication;
  let redis: IORedis;
  let keyDir: string;
  let conn: Connection;
  let clientModel: Model<Client>;
  let auditModel: Model<AuditEvent>;
  let refreshModel: Model<Record<string, unknown>>;
  let signer: TokenSigner;
  let logs: string[];
  let seq = 0;

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

  /** Real /authorize (consent pre-granted, member of the client tenant) => a valid code. */
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
    expect(code).toBeTruthy();
    return { clientId, userId, code: code! };
  }

  const post = (form: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(form).toString(),
    }) as unknown as Promise<Res & { json: () => Record<string, unknown> }>;
  const exchange = (clientId: string, code: string, over: Record<string, string> = {}) =>
    post({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      ...over,
    });
  const refreshReq = (clientId: string, rt: string) =>
    post({ grant_type: 'refresh_token', client_id: clientId, refresh_token: rt });

  async function firstRefresh(): Promise<{ clientId: string; userId: string; rt: string }> {
    const { clientId, userId, code } = await issueCode();
    const res = await exchange(clientId, code);
    expect(res.statusCode).toBe(200);
    return { clientId, userId, rt: res.json().refresh_token as string };
  }

  const codeKey = (code: string) => `authz_code:${sha256(code)}`;
  const issuedAudits = (userId: string) =>
    auditModel.find({ action: AuditAction.TOKEN_ISSUED, actorId: userId }).lean<AuditEvent[]>();
  const refreshedAudits = (userId: string) =>
    auditModel.find({ action: AuditAction.TOKEN_REFRESHED, actorId: userId }).lean<AuditEvent[]>();
  const reuseAudits = (clientId: string) =>
    auditModel.find({ action: AuditAction.TOKEN_REUSE_DETECTED, clientId }).lean<AuditEvent[]>();
  const familyDocs = (userId: string) =>
    refreshModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ _id: 1 })
      .lean<Record<string, unknown>[]>();

  const outage = () => new KeyProviderUnavailableError(new Error('x'));
  const atSign = (opts: SignOptions) => opts.typ === 'at+jwt';

  /**
   * Barrier: every access-token signature completes, then waits until released (before consume /
   * rotate). `held[i]` releases the i-th arrival.
   */
  function holdSigns() {
    const original = signer.sign.bind(signer);
    const held: Array<() => void> = [];
    const spy = jest.spyOn(signer, 'sign').mockImplementation(async (claims, opts) => {
      const out = await original(claims, opts);
      if (atSign(opts)) await new Promise<void>((r) => held.push(r));
      return out;
    });
    const arrived = async (n: number) => {
      const deadline = Date.now() + 10_000;
      while (held.length < n) {
        if (Date.now() > deadline) throw new Error(`only ${held.length}/${n} signs arrived`);
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    return { spy, held, arrived };
  }

  function expectOutage(res: Res) {
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(String(res.headers['cache-control'])).toContain('no-store');
    expect(JSON.parse(res.body)).toEqual(OUTAGE);
  }

  function expectInvalidGrant(res: Res) {
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_grant');
    expect(res.body).not.toMatch(/eyJ|access_token|refresh_token|id_token/);
  }

  beforeAll(async () => {
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    keyDir = await mkdtemp(join(tmpdir(), 'vg-debt388-int-'));
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
      controllers: [AuthorizeController, TokenController],
      providers: [
        AuthorizeService,
        AuthorizeRequestContextService,
        AuthorizationCodeService,
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
        TokenSigner,
        TokenVerifier,
        HtmlExceptionFilter,
        { provide: KEY_PROVIDER, useValue: provider },
        { provide: RedisService, useValue: new RedisService(redis) },
        { provide: ConfigService, useValue: cfg },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
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
    signer = app.get(TokenSigner);
    await app
      .get(ResourceService)
      .create({ resourceId: 'api', identifier: RESOURCE, scopes: ['api.read'] });
  }, 60_000);

  beforeEach(() => {
    logs = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((msg: unknown) => void logs.push(String(msg)));
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    // A dropped (signed but never returned) token must not reach any log line (I3 exposure).
    expect(logs.join('\n')).not.toContain('eyJ');
  });

  afterAll(async () => {
    if (conn) await conn.dropDatabase();
    if (app) await app.close();
    if (redis) redis.disconnect();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  describe('code grant', () => {
    it('C1: signing outage ⇒ 503, code intact (EXISTS, TTL not reset), no family, no audit; same code then ⇒ 200 once', async () => {
      const { clientId, userId, code } = await issueCode();
      const pttlBefore = await redis.pttl(codeKey(code));
      jest.spyOn(signer, 'sign').mockRejectedValueOnce(outage());

      const failed = await exchange(clientId, code);
      expectOutage(failed);
      expect(failed.body).not.toMatch(/eyJ|access_token/);
      expect(await redis.exists(codeKey(code))).toBe(1);
      const pttlAfter = await redis.pttl(codeKey(code));
      expect(pttlAfter).toBeGreaterThan(0);
      expect(pttlAfter).toBeLessThanOrEqual(pttlBefore);
      expect(await familyDocs(userId)).toHaveLength(0);
      expect(await issuedAudits(userId)).toHaveLength(0);

      jest.restoreAllMocks();
      const ok = await exchange(clientId, code);
      expect(ok.statusCode).toBe(200);
      expect(ok.json().refresh_token).toBeTruthy();
      expect(await familyDocs(userId)).toHaveLength(1);
      const audits = await issuedAudits(userId);
      expect(audits).toHaveLength(1);
      expect(audits[0].result).toBe('success');
      expect(await redis.exists(codeKey(code))).toBe(0);
    });

    it('C2: a plain signer error ⇒ 500 (not 503) and the code still works afterwards', async () => {
      const { clientId, userId, code } = await issueCode();
      jest.spyOn(signer, 'sign').mockRejectedValueOnce(new Error('signer bug'));
      const failed = await exchange(clientId, code);
      expect(failed.statusCode).toBe(500);
      expect(JSON.parse(failed.body).error).toBe('server_error');
      expect(await redis.exists(codeKey(code))).toBe(1);
      jest.restoreAllMocks();
      expect((await exchange(clientId, code)).statusCode).toBe(200);
      expect(await familyDocs(userId)).toHaveLength(1);
    });

    it('C3: two requests with the same code, both signed before consume ⇒ exactly one 200, one invalid_grant, one family', async () => {
      const { clientId, userId, code } = await issueCode();
      const gate = holdSigns();
      const a = exchange(clientId, code);
      const b = exchange(clientId, code);
      await gate.arrived(2); // both have an access token in hand, neither consumed yet
      for (const release of gate.held) release();
      const results = await Promise.all([a, b]);
      const ok = results.filter((r) => r.statusCode === 200);
      const lost = results.filter((r) => r.statusCode !== 200);
      expect(ok).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expectInvalidGrant(lost[0]);
      expect(await familyDocs(userId)).toHaveLength(1);
      expect((await issuedAudits(userId)).map((e) => e.result)).toEqual(['success']);
    });

    it('C4: A fails to sign while B succeeds ⇒ A 503, B 200; A retry ⇒ invalid_grant; one family', async () => {
      const { clientId, userId, code } = await issueCode();
      let releaseA!: () => void;
      let aArrived = false;
      jest.spyOn(signer, 'sign').mockImplementationOnce(async () => {
        aArrived = true;
        await new Promise<void>((r) => (releaseA = r));
        throw outage();
      });
      const a = exchange(clientId, code);
      while (!aArrived) await new Promise((r) => setTimeout(r, 5));
      const b = await exchange(clientId, code);
      expect(b.statusCode).toBe(200);
      releaseA();
      expectOutage(await a);
      expectInvalidGrant(await exchange(clientId, code));
      expect(await familyDocs(userId)).toHaveLength(1);
    });

    it('C5: refusals decided before signing still burn the code, and never sign', async () => {
      // (a) body resource ≠ bound resource ⇒ invalid_target
      const a = await issueCode();
      const sign = jest.spyOn(signer, 'sign');
      const resA = await exchange(a.clientId, a.code, { resource: 'https://other.example.com/' });
      expect(resA.statusCode).toBe(400);
      expect(JSON.parse(resA.body).error).toBe('invalid_target');
      expect(sign).not.toHaveBeenCalled();
      expect(await redis.exists(codeKey(a.code))).toBe(0);
      expectInvalidGrant(await exchange(a.clientId, a.code));

      // (b) a public (non admin-capable) client holding an aud=admin code ⇒ invalid_target
      const clientId = await mkClient();
      const userId = await seedOAuthUser(conn, { tenantId: TENANT });
      const codes = app.get(AuthorizationCodeService);
      const { code: adminCode } = await codes.create({
        clientId,
        redirectUri: REDIRECT,
        codeChallenge: CHALLENGE,
        resource: ADMIN,
        scope: 'openid',
        userId,
        sessionRef: sha256((await app.get(SessionService).create(userId, DEFAULT_TENANT_ID)).id),
      });
      const resB = await exchange(clientId, adminCode);
      expect(resB.statusCode).toBe(400);
      expect(JSON.parse(resB.body).error).toBe('invalid_target');
      expect(await redis.exists(codeKey(adminCode))).toBe(0);

      // (c) a code without sessionRef (pre-DEBT-043 shape) ⇒ invalid_grant, burned
      const { code: legacy } = await codes.create({
        clientId,
        redirectUri: REDIRECT,
        codeChallenge: CHALLENGE,
        resource: RESOURCE,
        scope: 'openid',
        userId,
      } as never);
      expectInvalidGrant(await exchange(clientId, legacy));
      expect(await redis.exists(codeKey(legacy))).toBe(0);

      expect(sign).not.toHaveBeenCalled();
      expect(await familyDocs(userId)).toHaveLength(0);
    });

    it('C6: wrong verifier / redirect_uri ⇒ invalid_grant, never signs, code intact (INV-13 for peek)', async () => {
      const { clientId, userId, code } = await issueCode();
      const sign = jest.spyOn(signer, 'sign');
      expectInvalidGrant(await exchange(clientId, code, { code_verifier: WRONG_VERIFIER }));
      expectInvalidGrant(
        await exchange(clientId, code, { redirect_uri: 'https://evil.example.com/cb' }),
      );
      expect(sign).not.toHaveBeenCalled();
      expect(await redis.exists(codeKey(code))).toBe(1);
      expect((await exchange(clientId, code)).statusCode).toBe(200);
      expect(await familyDocs(userId)).toHaveLength(1);
    });
  });

  describe('refresh grant', () => {
    it('R1: signing outage ⇒ 503, RT untouched (no successor, no stamps); same RT then ⇒ 200; 0 reuse', async () => {
      const { clientId, userId, rt } = await firstRefresh();
      jest.spyOn(signer, 'sign').mockRejectedValueOnce(outage());
      const failed = await refreshReq(clientId, rt);
      expectOutage(failed);
      expect(failed.body).not.toMatch(/eyJ|access_token|refresh_token/);
      const docs = await familyDocs(userId);
      expect(docs).toHaveLength(1);
      expect(docs[0].revokedAt ?? null).toBeNull();
      expect(docs[0].replacedBy ?? null).toBeNull();
      expect(docs[0].familyRevokedAt ?? null).toBeNull();
      expect(docs[0].reuseDetectedAt ?? null).toBeNull();
      expect(await refreshedAudits(userId)).toHaveLength(0);

      jest.restoreAllMocks();
      const ok = await refreshReq(clientId, rt);
      expect(ok.statusCode).toBe(200);
      expect(ok.json().refresh_token).toBeTruthy();
      expect(await reuseAudits(clientId)).toHaveLength(0);
      expect((await familyDocs(userId)).filter((d) => !d.revokedAt)).toHaveLength(1);
    });

    it('R2: after R1-style retry succeeded (RT0→RT1), a replay of RT0 is still reuse ⇒ family revoked + one alert', async () => {
      const { clientId, userId, rt } = await firstRefresh();
      jest.spyOn(signer, 'sign').mockRejectedValueOnce(outage());
      expectOutage(await refreshReq(clientId, rt));
      jest.restoreAllMocks();
      const ok = await refreshReq(clientId, rt);
      expect(ok.statusCode).toBe(200);
      const rt1 = ok.json().refresh_token as string;

      expectInvalidGrant(await refreshReq(clientId, rt));
      expect(await reuseAudits(clientId)).toHaveLength(1);
      expect((await familyDocs(userId)).every((d) => d.revokedAt)).toBe(true);
      expectInvalidGrant(await refreshReq(clientId, rt1)); // RT1 died with the family
    });

    it('R3: two refreshes of the same RT, both signed; release A then B ⇒ A 200, B invalid_grant + reuse, family dead', async () => {
      const { clientId, userId, rt } = await firstRefresh();
      const gate = holdSigns();
      const a = refreshReq(clientId, rt);
      await gate.arrived(1);
      const b = refreshReq(clientId, rt);
      await gate.arrived(2);
      gate.held[0]();
      const resA = await a;
      expect(resA.statusCode).toBe(200);
      const rt1 = resA.json().refresh_token as string;
      gate.held[1]();
      expectInvalidGrant(await b);
      expect(await reuseAudits(clientId)).toHaveLength(1);
      expect((await familyDocs(userId)).every((d) => d.revokedAt)).toBe(true);
      gate.spy.mockRestore();
      expectInvalidGrant(await refreshReq(clientId, rt1));
    });

    it('R3b: same race released together ⇒ ≤ 1×200, ≤ 1 usable successor, losers carry no token', async () => {
      const { clientId, userId, rt } = await firstRefresh();
      const gate = holdSigns();
      const reqs = [refreshReq(clientId, rt), refreshReq(clientId, rt)];
      await gate.arrived(2);
      for (const release of gate.held) release();
      const results = await Promise.all(reqs);
      expect(results.filter((r) => r.statusCode === 200).length).toBeLessThanOrEqual(1);
      for (const r of results.filter((x) => x.statusCode !== 200)) expectInvalidGrant(r);
      const docs = await familyDocs(userId);
      const root = docs[0];
      const liveChildren = docs.filter(
        (d) => !d.revokedAt && String(d.parentId) === String(root._id),
      );
      expect(liveChildren.length).toBeLessThanOrEqual(1);
      expect(docs.filter((d) => !d.revokedAt).length).toBeLessThanOrEqual(1);
    });

    it('R4: family revoked (/revoke) while the request holds signed tokens ⇒ invalid_grant, 0 reuse, no token', async () => {
      const { clientId, userId, rt } = await firstRefresh();
      const gate = holdSigns();
      const a = refreshReq(clientId, rt);
      await gate.arrived(1);
      const revoked = await app.inject({
        method: 'POST',
        url: '/revoke',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ client_id: clientId, token: rt }).toString(),
      });
      expect(revoked.statusCode).toBe(200);
      gate.held[0]();
      expectInvalidGrant(await a);
      expect(await reuseAudits(clientId)).toHaveLength(0);
      expect((await familyDocs(userId)).every((d) => d.revokedAt)).toBe(true);
      expect((await refreshedAudits(userId)).filter((e) => e.result === 'success')).toHaveLength(0);
    });
  });
});
