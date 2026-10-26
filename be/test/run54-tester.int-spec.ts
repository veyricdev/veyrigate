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
  `mongodb://localhost:27117/vg-int-run54t-${Date.now()}?directConnection=true`;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';
const RUN = `r54t${Date.now()}`;
const ISSUER = 'http://localhost:4000';
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
 * Tester risk tests, run 54 (DEBT-388 sign-before-commit). Independent of the dev suite: code TTL
 * running out while signing, N>=5 concurrent requests on one code / one RT with slow signing,
 * logout inside the signing window, wrong client_id/PKCE/redirect never signs, the ID-token (second)
 * signature failing after the access token was signed, RT expiring while signing, and the exposure
 * sinks (body, Nest log, every audit document) never carrying a JWT.
 */
describe('run 54 tester: DEBT-388 sign-before-commit risk tests', () => {
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
  async function issueCode(): Promise<{
    clientId: string;
    userId: string;
    code: string;
    sessionId: string;
  }> {
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
    return { clientId, userId, code: code!, sessionId: id };
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

  async function firstRefresh() {
    const c = await issueCode();
    const res = await exchange(c.clientId, c.code);
    expect(res.statusCode).toBe(200);
    return { ...c, rt: res.json().refresh_token as string };
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
    // Exposure sink: no audit document (any action, any field) ever carries a JWT.
    if (auditModel) {
      const all = await auditModel.find({}).lean();
      expect(all.length).toBeGreaterThan(0);
      expect(JSON.stringify(all)).not.toContain('eyJ');
    }
    if (conn) await conn.dropDatabase();
    if (app) await app.close();
    if (redis) redis.disconnect();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  const until = async (cond: () => Promise<boolean>, what: string) => {
    const deadline = Date.now() + 10_000;
    while (!(await cond())) {
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const noToken = (r: Res) => expect(r.body).not.toMatch(/eyJ|access_token|refresh_token|id_token/);

  describe('code grant', () => {
    it('T1: code TTL runs out while the request is signing ⇒ invalid_grant, no family, no success audit, no token', async () => {
      const { clientId, userId, code } = await issueCode();
      const gate = holdSigns();
      const a = exchange(clientId, code);
      await gate.arrived(1); // access token signed on the peeked code, consume not yet run
      await redis.pexpire(codeKey(code), 1);
      await until(async () => (await redis.exists(codeKey(code))) === 0, 'code expiry');
      gate.held[0]();
      expectInvalidGrant(await a);
      expect(gate.spy).toHaveBeenCalled();
      expect(await familyDocs(userId)).toHaveLength(0);
      expect((await issuedAudits(userId)).filter((e) => e.result === 'success')).toHaveLength(0);
    });

    it('T2: 8 concurrent exchanges of one code, all signed and held, released together ⇒ exactly 1×200, 7×invalid_grant, 1 family, 1 success audit', async () => {
      const { clientId, userId, code } = await issueCode();
      const gate = holdSigns();
      const reqs = Array.from({ length: 8 }, () => exchange(clientId, code));
      await gate.arrived(8);
      for (const release of gate.held) release();
      const results = await Promise.all(reqs);
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      const lost = results.filter((r) => r.statusCode !== 200);
      expect(lost).toHaveLength(7);
      for (const r of lost) expectInvalidGrant(r);
      expect(await familyDocs(userId)).toHaveLength(1);
      expect((await issuedAudits(userId)).filter((e) => e.result === 'success')).toHaveLength(1);
    });

    it('T3: 6 concurrent exchanges released one at a time in reverse arrival order ⇒ first released wins, the 5 later ones invalid_grant', async () => {
      const { clientId, userId, code } = await issueCode();
      const gate = holdSigns();
      const settledAt: number[] = [];
      const reqs = Array.from({ length: 6 }, (_v, i) =>
        exchange(clientId, code).then((r) => {
          settledAt.push(i);
          return r;
        }),
      );
      await gate.arrived(6);
      const order = [...gate.held].reverse();
      const statuses: number[] = [];
      for (const release of order) {
        const before = settledAt.length;
        release();
        await until(async () => settledAt.length > before, 'one settle');
        statuses.push((await reqs[settledAt[settledAt.length - 1]]).statusCode);
      }
      expect(statuses).toEqual([200, 400, 400, 400, 400, 400]);
      for (const r of await Promise.all(reqs)) if (r.statusCode !== 200) expectInvalidGrant(r);
      expect(await familyDocs(userId)).toHaveLength(1);
    });

    it('T4: logout (session revoke) while the request holds signed tokens ⇒ invalid_grant, code burned, no live family, no token', async () => {
      const { clientId, userId, code, sessionId } = await issueCode();
      const gate = holdSigns();
      const a = exchange(clientId, code);
      await gate.arrived(1);
      await app.get(SessionService).revoke(sessionId);
      gate.held[0]();
      expectInvalidGrant(await a);
      expect(await redis.exists(codeKey(code))).toBe(0);
      expect((await familyDocs(userId)).filter((d) => !d.revokedAt)).toHaveLength(0);
      expect((await issuedAudits(userId)).filter((e) => e.result === 'success')).toHaveLength(0);
      gate.spy.mockRestore();
      expectInvalidGrant(await exchange(clientId, code));
    });

    it('T5: another client of the same tenant replays the code with the right verifier, or wrong verifier/redirect ⇒ invalid_grant, never signs, code intact', async () => {
      const { clientId, userId, code } = await issueCode();
      const other = await mkClient();
      const sign = jest.spyOn(signer, 'sign');
      expectInvalidGrant(await exchange(other, code));
      expectInvalidGrant(await exchange(clientId, code, { code_verifier: WRONG_VERIFIER }));
      expectInvalidGrant(await exchange(clientId, code, { redirect_uri: `${REDIRECT}/x` }));
      expect(sign).not.toHaveBeenCalled();
      expect(await redis.exists(codeKey(code))).toBe(1);
      sign.mockRestore();
      expect((await exchange(clientId, code)).statusCode).toBe(200);
      expect(await familyDocs(userId)).toHaveLength(1);
    });

    it('T6: ID-token signature fails AFTER the access token was signed ⇒ 503, code intact, nothing written; 3 failed retries then success ⇒ 1 family, 1 success audit', async () => {
      const { clientId, userId, code } = await issueCode();
      const original = signer.sign.bind(signer);
      let failures = 3;
      const spy = jest.spyOn(signer, 'sign').mockImplementation(async (claims, opts) => {
        if (!atSign(opts) && failures > 0) {
          failures--;
          throw outage();
        }
        return original(claims, opts);
      });
      for (let i = 0; i < 3; i++) {
        const r = await exchange(clientId, code);
        expectOutage(r);
        noToken(r);
        expect(await redis.exists(codeKey(code))).toBe(1);
      }
      expect(spy.mock.calls.filter(([, o]) => atSign(o))).toHaveLength(3);
      expect(await familyDocs(userId)).toHaveLength(0);
      expect(await issuedAudits(userId)).toHaveLength(0);
      const ok = await exchange(clientId, code);
      expect(ok.statusCode).toBe(200);
      expect(ok.json().id_token).toBeTruthy();
      expect(await familyDocs(userId)).toHaveLength(1);
      expect((await issuedAudits(userId)).map((e) => e.result)).toEqual(['success']);
    });
  });

  describe('refresh grant', () => {
    it('T7: ID-token signature fails after the AT was signed ⇒ 503 twice, RT untouched; same RT ⇒ 200; 0 reuse', async () => {
      const { clientId, userId, rt } = await firstRefresh();
      const original = signer.sign.bind(signer);
      let failures = 2;
      jest.spyOn(signer, 'sign').mockImplementation(async (claims, opts) => {
        if (!atSign(opts) && failures > 0) {
          failures--;
          throw outage();
        }
        return original(claims, opts);
      });
      for (let i = 0; i < 2; i++) {
        const r = await refreshReq(clientId, rt);
        expectOutage(r);
        noToken(r);
      }
      const docs = await familyDocs(userId);
      expect(docs).toHaveLength(1);
      expect(docs[0].revokedAt ?? null).toBeNull();
      expect(docs[0].replacedBy ?? null).toBeNull();
      const ok = await refreshReq(clientId, rt);
      expect(ok.statusCode).toBe(200);
      expect(ok.json().id_token).toBeTruthy();
      expect(await reuseAudits(clientId)).toHaveLength(0);
      expect((await familyDocs(userId)).filter((d) => !d.revokedAt)).toHaveLength(1);
    });

    it('T8: 6 concurrent refreshes of one RT, all signed, released together ⇒ ≤1×200, the rest invalid_grant without token, ≤1 live doc, exactly 1 child', async () => {
      const { clientId, userId, rt } = await firstRefresh();
      const gate = holdSigns();
      const reqs = Array.from({ length: 6 }, () => refreshReq(clientId, rt));
      await gate.arrived(6);
      for (const release of gate.held) release();
      const results = await Promise.all(reqs);
      const ok = results.filter((r) => r.statusCode === 200);
      expect(ok.length).toBeLessThanOrEqual(1);
      for (const r of results.filter((x) => x.statusCode !== 200)) expectInvalidGrant(r);
      const docs = await familyDocs(userId);
      const live = docs.filter((d) => !d.revokedAt);
      expect(live.length).toBeLessThanOrEqual(1);
      expect(docs.filter((d) => String(d.parentId) === String(docs[0]._id))).toHaveLength(1);
      // A loser that met the committed swap is reuse ⇒ the family (incl. the winner's RT) dies.
      const reuse = (await reuseAudits(clientId)).length;
      if (reuse > 0) expect(live).toHaveLength(0);
      process.stdout.write(
        `[run54-T8] ok=${ok.length} reuse=${reuse} live=${live.length} docs=${docs.length}\n`,
      );
    });

    it('T9: 6 concurrent refreshes; A released and answered first, then the other 5 ⇒ A 200, 5×invalid_grant, reuse detected, family dead', async () => {
      const { clientId, userId, rt } = await firstRefresh();
      const gate = holdSigns();
      const first = refreshReq(clientId, rt);
      await gate.arrived(1);
      const rest = Array.from({ length: 5 }, () => refreshReq(clientId, rt));
      await gate.arrived(6);
      gate.held[0]();
      const a = await first;
      expect(a.statusCode).toBe(200);
      const rt1 = a.json().refresh_token as string;
      for (const release of gate.held.slice(1)) release();
      for (const r of await Promise.all(rest)) expectInvalidGrant(r);
      expect((await reuseAudits(clientId)).length).toBeGreaterThanOrEqual(1);
      expect((await familyDocs(userId)).every((d) => d.revokedAt)).toBe(true);
      gate.spy.mockRestore();
      expectInvalidGrant(await refreshReq(clientId, rt1));
    });

    it('T10: logout (session revoke + family sweep) while the refresh holds signed tokens ⇒ invalid_grant, 0 reuse, no token, no success audit', async () => {
      const { clientId, userId, rt, sessionId } = await firstRefresh();
      const gate = holdSigns();
      const a = refreshReq(clientId, rt);
      await gate.arrived(1);
      await app.get(SessionService).revoke(sessionId);
      expect(
        await app.get(RefreshTokenService).revokeForSession(userId, sha256(sessionId), new Date()),
      ).toBe(1);
      gate.held[0]();
      expectInvalidGrant(await a);
      expect(await reuseAudits(clientId)).toHaveLength(0);
      expect((await familyDocs(userId)).every((d) => d.revokedAt)).toBe(true);
      expect((await refreshedAudits(userId)).filter((e) => e.result === 'success')).toHaveLength(0);
    });

    it('T11: RT expires while the refresh is signing ⇒ invalid_grant, no successor, 0 reuse', async () => {
      const { clientId, userId, rt } = await firstRefresh();
      const gate = holdSigns();
      const a = refreshReq(clientId, rt);
      await gate.arrived(1);
      await refreshModel.updateMany(
        { userId: new Types.ObjectId(userId) },
        { $set: { expiresAt: new Date(Date.now() - 1000) } },
      );
      gate.held[0]();
      expectInvalidGrant(await a);
      const docs = await familyDocs(userId);
      expect(docs).toHaveLength(1);
      expect(docs[0].replacedBy ?? null).toBeNull();
      expect(await reuseAudits(clientId)).toHaveLength(0);
    });
  });
});
