import { jest } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
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
import { deriveS256Challenge } from '../src/common/crypto/pkce.util';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { RedisService } from '../src/database/redis/redis.service';
import { ClientAuthenticationService } from '../src/modules/clients/client-authentication.service';
import { ClientCorsService } from '../src/modules/clients/client-cors.service';
import { ClientCredentialService } from '../src/modules/clients/client-credential.service';
import { ClientService, type Client } from '../src/modules/clients/client.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { UserTenantService } from '../src/modules/identity/user-tenant.service';
import { ADMIN_LOCKED_UNTIL, UserService } from '../src/modules/identity/user.service';
import { KEY_PROVIDER } from '../src/modules/keys/key-provider';
import { LocalKeyProvider } from '../src/modules/keys/local-key-provider';
import { TokenSigner } from '../src/modules/keys/token-signer';
import { TokenVerifier } from '../src/modules/keys/token-verifier';
import { AuthorizeController } from '../src/modules/oauth/authorize/authorize.controller';
import { AuthorizeRequestContextService } from '../src/modules/oauth/authorize/authorize-request-context.service';
import { AuthorizeService } from '../src/modules/oauth/authorize/authorize.service';
import { AuthorizationCodeService } from '../src/modules/oauth/code/authorization-code.service';
import { ConsentService, type Consent } from '../src/modules/oauth/consent/consent.service';
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
  `mongodb://localhost:27117/vg-int-coderecheck-${Date.now()}?directConnection=true`;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';
const RUN = `cr${Date.now()}`;
const ISSUER = 'http://localhost:4000';
const REDIRECT = 'https://app.example.com/callback';
const RESOURCE = 'https://api.example.com/';
const SCOPE = 'openid offline_access api.read';
const TENANT = 'tenant-B';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = deriveS256Challenge(VERIFIER);

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

// Run 35 Task 3 (DEBT-116/128/141/144/156): the code grant re-reads the CURRENT client, redirect_uri,
// user lock, membership and consent AFTER the refresh family insert; any failure revokes the family
// and answers the same opaque invalid_grant (reason only in audit).
describe('/token code grant re-check after the family insert (run 35 Task 3)', () => {
  let app: NestFastifyApplication;
  let redis: IORedis;
  let keyDir: string;
  let conn: Connection;
  let clientModel: Model<Client>;
  let auditModel: Model<AuditEvent>;
  let refreshModel: Model<Record<string, unknown>>;
  let tokens: TokenService;
  let refresh: RefreshTokenService;
  let consents: ConsentService;
  let seq = 0;

  /** A fresh public client of TENANT (refresh-capable) so each case owns its client state. */
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

  const issuedAudits = (userId: string) =>
    auditModel.find({ action: AuditAction.TOKEN_ISSUED, actorId: userId }).lean<AuditEvent[]>();
  const familyDocs = (userId: string) =>
    refreshModel.find({ userId: new Types.ObjectId(userId) }).lean<Record<string, unknown>[]>();

  /** Refused with invalid_grant: no token, exactly one TOKEN_ISSUED failure with `reason`, no live family. */
  async function expectRefused(
    res: { statusCode: number; body: string },
    userId: string,
    reason: string,
    familyMinted = true,
  ): Promise<void> {
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_grant');
    expect(res.body).not.toContain('access_token');
    const audits = await issuedAudits(userId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ result: 'failure', reason });
    const docs = await familyDocs(userId);
    expect(docs).toHaveLength(familyMinted ? 1 : 0);
    expect(docs.every((d) => d.revokedAt)).toBe(true);
  }

  /** Run `mutate` right AFTER the real family insert (spy calls the original first, F7). */
  function afterInsert(mutate: (clientId: string, userId: string) => Promise<unknown>) {
    const original = tokens.issueForAuthorizationCode.bind(tokens);
    return jest
      .spyOn(tokens, 'issueForAuthorizationCode')
      .mockImplementationOnce(async (client, data, audit) => {
        const out = await original(client, data, audit);
        expect(out.familyId).toBeTruthy();
        await mutate(client.clientId, data.userId);
        return out;
      });
  }

  // Admin-side write orders (state first, sweep second), as the admin controllers do.
  const disableClient = async (clientId: string) => {
    await clientModel.updateOne({ clientId }, { $set: { disabledAt: new Date() } });
    await refresh.revokeForClient(clientId, new Date());
  };
  const revokeConsent = async (clientId: string, userId: string) => {
    const c = await consents.find(userId, clientId, RESOURCE);
    await consents.revokeById(
      String((c as Consent & { _id: Types.ObjectId })._id),
      userId,
      [clientId],
      new Date(),
    );
    await refresh.revokeForConsent(userId, clientId, RESOURCE, new Date());
  };
  // Run 36 G1: only an ADMIN lock (or a vanished user) refuses a grant; a brute-force lock does not.
  const lockOnly = (userId: string) =>
    conn
      .model('User')
      .updateOne(
        { _id: new Types.ObjectId(userId) },
        { $set: { lockedUntil: ADMIN_LOCKED_UNTIL } },
      );
  const tempLock = (userId: string) =>
    conn
      .model('User')
      .updateOne(
        { _id: new Types.ObjectId(userId) },
        { $set: { lockedUntil: new Date(Date.now() + 3_600_000) } },
      );
  // Admin removes the resource from the client's allowlist (DEBT-210).
  const dropResource = (clientId: string) =>
    clientModel.updateOne({ clientId }, { $set: { allowedResources: [] } });
  const suspend = (userId: string) =>
    conn
      .model('UserTenant')
      .updateOne(
        { userId: new Types.ObjectId(userId), tenantId: TENANT },
        { $set: { status: 'suspended' } },
      );

  beforeAll(async () => {
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    keyDir = await mkdtemp(join(tmpdir(), 'vg-coderecheck-int-'));
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
    tokens = app.get(TokenService);
    refresh = app.get(RefreshTokenService);
    consents = app.get(ConsentService);
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

  it('control: nothing changed => 200 with tokens, exactly one TOKEN_ISSUED success, family alive', async () => {
    const { clientId, userId, code } = await issueCode();
    const res = await exchange(clientId, code);
    expect(res.statusCode).toBe(200);
    expect(res.json().refresh_token).toBeTruthy();
    const audits = await issuedAudits(userId);
    expect(audits).toHaveLength(1);
    expect(audits[0].result).toBe('success');
    const docs = await familyDocs(userId);
    expect(docs).toHaveLength(1);
    expect(docs[0].revokedAt).toBeFalsy();
  });

  it('DEBT-156: client disabled before /token => refused at client auth (existing behaviour), no token', async () => {
    const { clientId, userId, code } = await issueCode();
    await disableClient(clientId);
    const res = await exchange(clientId, code);
    expect([400, 401]).toContain(res.statusCode);
    expect(res.json().access_token).toBeUndefined();
    expect(await familyDocs(userId)).toHaveLength(0);
  });

  it('DEBT-156 race: client disabled (+ sweep) right after the family insert => invalid_grant, family revoked, reason client_disabled', async () => {
    const { clientId, userId, code } = await issueCode();
    afterInsert((cid) => disableClient(cid));
    await expectRefused(await exchange(clientId, code), userId, 'client_disabled');
  });

  it('DEBT-156 race, state write only (no sweep): the re-check itself revokes the family', async () => {
    const { clientId, userId, code } = await issueCode();
    afterInsert((cid) =>
      clientModel.updateOne({ clientId: cid }, { $set: { disabledAt: new Date() } }),
    );
    await expectRefused(await exchange(clientId, code), userId, 'client_disabled');
  });

  it('DEBT-128: redirect_uri removed from the client after the code => invalid_grant, reason redirect_uri_unregistered', async () => {
    const { clientId, userId, code } = await issueCode();
    await clientModel.updateOne(
      { clientId },
      { $set: { redirectUris: ['https://app.example.com/other'] } },
    );
    await expectRefused(await exchange(clientId, code), userId, 'redirect_uri_unregistered');
  });

  it('DEBT-144: consent revoked (admin order) after the code => invalid_grant, reason consent_revoked', async () => {
    const { clientId, userId, code } = await issueCode();
    await revokeConsent(clientId, userId);
    await expectRefused(await exchange(clientId, code), userId, 'consent_revoked');
  });

  it('DEBT-144 race: consent revoked right after the family insert => invalid_grant, family revoked', async () => {
    const { clientId, userId, code } = await issueCode();
    afterInsert((cid, uid) => revokeConsent(cid, uid));
    await expectRefused(await exchange(clientId, code), userId, 'consent_revoked');
  });

  it('Q35.5: a consent policy/terms version bump within the code lifetime => invalid_grant (consent_revoked)', async () => {
    const { clientId, userId, code } = await issueCode();
    await conn
      .model('Consent')
      .updateOne(
        { userId: new Types.ObjectId(userId), clientId },
        { $set: { policyVersion: '0' } },
      );
    await expectRefused(await exchange(clientId, code), userId, 'consent_revoked');
  });

  it('DEBT-141: user locked (lockedUntil only) after the code => invalid_grant, reason user_locked', async () => {
    const { clientId, userId, code } = await issueCode();
    await lockOnly(userId);
    await expectRefused(await exchange(clientId, code), userId, 'user_locked');
  });

  it('DEBT-141 race: lockedUntil written right after the family insert (no sweep) => invalid_grant, family revoked', async () => {
    const { clientId, userId, code } = await issueCode();
    afterInsert((_cid, uid) => lockOnly(uid));
    await expectRefused(await exchange(clientId, code), userId, 'user_locked');
  });

  it('DEBT-141: an EXPIRED lock does not refuse the grant', async () => {
    const { clientId, userId, code } = await issueCode();
    await conn
      .model('User')
      .updateOne(
        { _id: new Types.ObjectId(userId) },
        { $set: { lockedUntil: new Date(Date.now() - 1000) } },
      );
    expect((await exchange(clientId, code)).statusCode).toBe(200);
  });

  it('G1: a brute-force (temporary) lock does NOT refuse the code grant nor the refresh; family alive', async () => {
    const { clientId, userId, code } = await issueCode();
    await tempLock(userId);
    const res = await exchange(clientId, code);
    expect(res.statusCode).toBe(200);
    const rt = res.json().refresh_token as string;
    const refreshed = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: rt,
      }).toString(),
    });
    expect(refreshed.statusCode).toBe(200);
    const docs = await familyDocs(userId);
    expect(docs).toHaveLength(2);
    expect(docs.filter((d) => !d.revokedAt)).toHaveLength(1);
  });

  it('DEBT-210: resource removed from the client allowlist after the code => invalid_grant, reason resource_not_allowed', async () => {
    const { clientId, userId, code } = await issueCode();
    await dropResource(clientId);
    await expectRefused(await exchange(clientId, code), userId, 'resource_not_allowed');
  });

  it('DEBT-210 race: resource removed right after the family insert => invalid_grant, family revoked', async () => {
    const { clientId, userId, code } = await issueCode();
    afterInsert((cid) => dropResource(cid));
    await expectRefused(await exchange(clientId, code), userId, 'resource_not_allowed');
  });

  it('DEBT-116: membership suspended after the code => invalid_grant, reason not_member', async () => {
    const { clientId, userId, code } = await issueCode();
    await suspend(userId);
    await expectRefused(await exchange(clientId, code), userId, 'not_member');
  });

  it('DEBT-116 race: membership suspended right after the family insert => invalid_grant, family revoked', async () => {
    const { clientId, userId, code } = await issueCode();
    afterInsert((_cid, uid) => suspend(uid));
    await expectRefused(await exchange(clientId, code), userId, 'not_member');
  });

  it('every refusal body is byte-identical to the invalid_grant of a bogus code (no enumeration)', async () => {
    const bodies: string[] = [];
    for (const mutate of [
      (cid: string) =>
        clientModel.updateOne({ clientId: cid }, { $set: { disabledAt: new Date() } }),
      (cid: string) =>
        clientModel.updateOne(
          { clientId: cid },
          { $set: { redirectUris: ['https://x.example/'] } },
        ),
      (_cid: string, uid: string) => lockOnly(uid),
      (_cid: string, uid: string) => suspend(uid),
      (cid: string) => dropResource(cid),
      (cid: string, uid: string) => revokeConsent(cid, uid),
    ]) {
      const { clientId, code } = await issueCode();
      afterInsert(mutate);
      bodies.push((await exchange(clientId, code)).body);
      jest.restoreAllMocks();
    }
    const { clientId } = await issueCode();
    const bogus = (await exchange(clientId, 'bogus-code')).body;
    expect(JSON.parse(bogus).error).toBe('invalid_grant');
    for (const b of bodies) expect(b).toBe(bogus);
  });

  it('fail-closed: a DB error in the re-check => 500, no token, family revoked, audit recheck_failed', async () => {
    const { clientId, userId, code } = await issueCode();
    jest
      .spyOn(app.get(UserTenantService), 'isActiveMember')
      .mockRejectedValueOnce(new Error('mongo down secret-detail'));
    const res = await exchange(clientId, code);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('access_token');
    expect(res.body).not.toContain('secret-detail');
    const audits = await issuedAudits(userId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ result: 'failure', reason: 'recheck_failed' });
    const docs = await familyDocs(userId);
    expect(docs).toHaveLength(1);
    expect(docs[0].revokedAt).toBeTruthy();
  });

  it('the code stays single-use: a refused code cannot be retried after the state is restored', async () => {
    const { clientId, userId, code } = await issueCode();
    await suspend(userId);
    expect((await exchange(clientId, code)).statusCode).toBe(400);
    await conn
      .model('UserTenant')
      .updateOne(
        { userId: new Types.ObjectId(userId), tenantId: TENANT },
        { $set: { status: 'active' } },
      );
    const retry = await exchange(clientId, code);
    expect(retry.statusCode).toBe(400);
    expect(retry.json().error).toBe('invalid_grant');
  });

  // Run 36 Task 2 (DEBT-207, G4): the refresh grant re-reads client / user (admin lock) /
  // membership AFTER rotate; a failure revokes the whole family and answers the opaque invalid_grant.
  describe('refresh grant re-check after rotate (run 36 Task 2)', () => {
    /** Code grant once => a live first refresh token of a fresh family. */
    async function firstRefresh(): Promise<{ clientId: string; userId: string; rt: string }> {
      const { clientId, userId, code } = await issueCode();
      const res = await exchange(clientId, code);
      expect(res.statusCode).toBe(200);
      return { clientId, userId, rt: res.json().refresh_token as string };
    }

    const refreshReq = (clientId: string, rt: string) =>
      app.inject({
        method: 'POST',
        url: '/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          refresh_token: rt,
        }).toString(),
      });

    const refreshedAudits = (userId: string) =>
      auditModel
        .find({ action: AuditAction.TOKEN_REFRESHED, actorId: userId })
        .lean<AuditEvent[]>();

    /** Run `mutate` right AFTER the real rotate (spy calls the original first). */
    function afterRotate(mutate: (clientId: string, userId: string) => Promise<unknown>) {
      const original = refresh.rotate.bind(refresh);
      return jest
        .spyOn(refresh, 'rotate')
        .mockImplementationOnce(async (...args: Parameters<RefreshTokenService['rotate']>) => {
          const out = await original(...args);
          await mutate(out.clientId, out.userId);
          return out;
        });
    }

    async function expectRefreshRefused(
      clientId: string,
      userId: string,
      rt: string,
      res: { statusCode: number; body: string },
      reason: string,
    ): Promise<void> {
      // Reference body from a live client (the case's own client may be disabled by now).
      const bogus = (await refreshReq(await mkClient(), 'bogus-refresh-token')).body;
      expect(JSON.parse(bogus).error).toBe('invalid_grant');
      expect(res.statusCode).toBe(400);
      expect(res.body).toBe(bogus);
      const docs = await familyDocs(userId);
      expect(docs).toHaveLength(2); // original + the successor minted by rotate
      expect(docs.every((d) => d.revokedAt)).toBe(true);
      const audits = await refreshedAudits(userId);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ result: 'failure', reason });
      expect(JSON.stringify(audits[0])).not.toContain(rt);
      // Replay of the old token gets no token (a disabled client already fails client auth).
      const replay = await refreshReq(clientId, rt);
      expect(replay.json().access_token).toBeUndefined();
      expect(replay.json().error).toBe(
        reason === 'client_disabled' ? 'invalid_client' : 'invalid_grant',
      );
    }

    it('control: nothing changed => 200, one TOKEN_REFRESHED success, successor alive', async () => {
      const { clientId, userId, rt } = await firstRefresh();
      const res = await refreshReq(clientId, rt);
      expect(res.statusCode).toBe(200);
      const audits = await refreshedAudits(userId);
      expect(audits).toHaveLength(1);
      expect(audits[0].result).toBe('success');
      expect((await familyDocs(userId)).filter((d) => !d.revokedAt)).toHaveLength(1);
    });

    it('race: admin lock written right after rotate => invalid_grant, family revoked, reason user_locked', async () => {
      const { clientId, userId, rt } = await firstRefresh();
      afterRotate((_cid, uid) => lockOnly(uid));
      const res = await refreshReq(clientId, rt);
      await expectRefreshRefused(clientId, userId, rt, res, 'user_locked');
    });

    it('race: membership suspended right after rotate => invalid_grant, family revoked, reason not_member', async () => {
      const { clientId, userId, rt } = await firstRefresh();
      afterRotate((_cid, uid) => suspend(uid));
      const res = await refreshReq(clientId, rt);
      await expectRefreshRefused(clientId, userId, rt, res, 'not_member');
    });

    it('race: client disabled (state write only) right after rotate => invalid_grant, family revoked, reason client_disabled', async () => {
      const { clientId, userId, rt } = await firstRefresh();
      afterRotate((cid) =>
        clientModel.updateOne({ clientId: cid }, { $set: { disabledAt: new Date() } }),
      );
      const res = await refreshReq(clientId, rt);
      await expectRefreshRefused(clientId, userId, rt, res, 'client_disabled');
    });

    it('race: client disabled + sweep right after rotate => invalid_grant, every family doc revoked', async () => {
      const { clientId, userId, rt } = await firstRefresh();
      afterRotate((cid) => disableClient(cid));
      const res = await refreshReq(clientId, rt);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_grant');
      expect((await familyDocs(userId)).every((d) => d.revokedAt)).toBe(true);
    });

    it('G1 control: a brute-force (temporary) lock right after rotate => 200, family alive', async () => {
      const { clientId, userId, rt } = await firstRefresh();
      afterRotate((_cid, uid) => tempLock(uid));
      const res = await refreshReq(clientId, rt);
      expect(res.statusCode).toBe(200);
      expect((await familyDocs(userId)).filter((d) => !d.revokedAt)).toHaveLength(1);
    });

    it('fail-closed: a DB error in the refresh re-check => 500, no token, family revoked, audit recheck_failed', async () => {
      const { clientId, userId, rt } = await firstRefresh();
      jest
        .spyOn(app.get(UserTenantService), 'isActiveMember')
        .mockRejectedValueOnce(new Error('mongo down secret-detail'));
      const res = await refreshReq(clientId, rt);
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('access_token');
      expect(res.body).not.toContain('secret-detail');
      expect((await familyDocs(userId)).every((d) => d.revokedAt)).toBe(true);
      const audits = await refreshedAudits(userId);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ result: 'failure', reason: 'recheck_failed' });
    });

    // ---- run 36 tester: risk matrix additions (identity/lock kind, exposure, state/replay,
    // dependency failure, concurrency). Each pins one invariant the dev tests did not cover.
    const reuseAudits = (clientId: string) =>
      auditModel.find({ action: AuditAction.TOKEN_REUSE_DETECTED, clientId }).lean<AuditEvent[]>();
    const failedLogins = async (userId: string, n: number) => {
      for (let i = 0; i < n; i++) await app.get(UserService).recordFailedLogin(userId);
    };

    it('tester G1: brute-force after an ADMIN lock cannot downgrade it => code grant still refused (user_locked)', async () => {
      const { clientId, userId, code } = await issueCode();
      await lockOnly(userId);
      await failedLogins(userId, 7);
      const u = await app.get(UserService).findById(userId);
      expect(u?.lockedUntil?.getTime()).toBe(ADMIN_LOCKED_UNTIL.getTime());
      await expectRefused(await exchange(clientId, code), userId, 'user_locked');
    });

    it('tester G1: brute-force after an ADMIN lock cannot downgrade it => refresh still refused, family dead', async () => {
      const { clientId, userId, rt } = await firstRefresh();
      await lockOnly(userId);
      await failedLogins(userId, 7);
      const res = await refreshReq(clientId, rt);
      await expectRefreshRefused(clientId, userId, rt, res, 'user_locked');
    });

    it('tester G1: a brute-force lock reached through real failed logins (>=5) keeps refresh alive', async () => {
      const { clientId, userId, rt } = await firstRefresh();
      await failedLogins(userId, 6);
      const u = await app.get(UserService).findById(userId);
      expect(u?.lockedUntil && u.lockedUntil > new Date()).toBe(true);
      expect(u?.lockedUntil?.getTime()).not.toBe(ADMIN_LOCKED_UNTIL.getTime());
      const res = await refreshReq(clientId, rt);
      expect(res.statusCode).toBe(200);
      expect(res.json().refresh_token).toBeTruthy();
    });

    it('tester exposure: a refused refresh (reason or recheck_failed) never signs a token', async () => {
      const sign = jest.spyOn(tokens, 'signTokensForRefresh');
      const a = await firstRefresh();
      sign.mockClear();
      afterRotate((_cid, uid) => lockOnly(uid));
      const refused = await refreshReq(a.clientId, a.rt);
      expect(refused.statusCode).toBe(400);
      expect(sign).not.toHaveBeenCalled();

      const b = await firstRefresh();
      sign.mockClear();
      jest
        .spyOn(app.get(UserTenantService), 'isActiveMember')
        .mockRejectedValueOnce(new Error('mongo down'));
      const failed = await refreshReq(b.clientId, b.rt);
      expect(failed.statusCode).toBe(500);
      expect(sign).not.toHaveBeenCalled();
      for (const r of [refused, failed]) {
        expect(r.body).not.toMatch(/access_token|refresh_token|id_token/);
      }
    });

    it('tester DEBT-067: revokeFamily throws on a refusal => 500, no token, refusal audit kept; replay of the old token gets nothing', async () => {
      const { clientId, userId, rt } = await firstRefresh();
      const sign = jest.spyOn(tokens, 'signTokensForRefresh');
      sign.mockClear();
      afterRotate((_cid, uid) => lockOnly(uid));
      jest.spyOn(refresh, 'revokeFamily').mockRejectedValueOnce(new Error('mongo down'));
      const res = await refreshReq(clientId, rt);
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toMatch(/access_token|refresh_token/);
      expect(sign).not.toHaveBeenCalled();
      const audits = await refreshedAudits(userId);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ result: 'failure', reason: 'user_locked' });
      jest.restoreAllMocks();
      const replay = await refreshReq(clientId, rt);
      expect(replay.statusCode).toBe(400);
      expect(replay.json().access_token).toBeUndefined();
      // The successor (value never delivered) is swept by reuse detection on that replay.
      expect((await familyDocs(userId)).every((d) => d.revokedAt)).toBe(true);
    });

    it('tester: user vanished right after rotate => invalid_grant, reason user_locked, family dead', async () => {
      const { clientId, userId, rt } = await firstRefresh();
      afterRotate((_cid, uid) => conn.model('User').deleteOne({ _id: new Types.ObjectId(uid) }));
      const res = await refreshReq(clientId, rt);
      await expectRefreshRefused(clientId, userId, rt, res, 'user_locked');
    });

    it('tester cross-tenant: membership of the client tenant removed (user still active elsewhere) => not_member', async () => {
      const { clientId, userId, rt } = await firstRefresh();
      await conn.model('UserTenant').create({
        userId: new Types.ObjectId(userId),
        tenantId: DEFAULT_TENANT_ID,
        status: 'active',
      });
      await conn
        .model('UserTenant')
        .deleteOne({ userId: new Types.ObjectId(userId), tenantId: TENANT });
      const res = await refreshReq(clientId, rt);
      await expectRefreshRefused(clientId, userId, rt, res, 'not_member');
    });

    it('tester concurrency: 5 parallel refreshes of one token with an admin lock => no 200, whole family dead', async () => {
      const { clientId, userId, rt } = await firstRefresh();
      await lockOnly(userId);
      const results = await Promise.all(Array.from({ length: 5 }, () => refreshReq(clientId, rt)));
      for (const r of results) {
        expect(r.statusCode).not.toBe(200);
        expect(r.body).not.toMatch(/access_token|refresh_token/);
      }
      expect((await familyDocs(userId)).every((d) => d.revokedAt)).toBe(true);
    });

    // DEBT-215 (senior 🟡): PIN the current behaviour so a fix flips this test knowingly. A replay of
    // the old token after a post-rotate refusal is classified as reuse => one TOKEN_REUSE_DETECTED
    // (count 0: the family is already dead). No bypass: no token, family stays dead.
    it.each([
      ['recheck_failed (500)', 'fail'],
      ['user_locked (400)', 'lock'],
    ])(
      'tester DEBT-215 pin: replay after %s => invalid_grant, no token, false TOKEN_REUSE_DETECTED (count 0)',
      async (_n, kind) => {
        const { clientId, userId, rt } = await firstRefresh();
        if (kind === 'fail') {
          jest
            .spyOn(app.get(UserTenantService), 'isActiveMember')
            .mockRejectedValueOnce(new Error('mongo down'));
        } else {
          afterRotate((_cid, uid) => lockOnly(uid));
        }
        const first = await refreshReq(clientId, rt);
        expect(first.statusCode).toBe(kind === 'fail' ? 500 : 400);
        expect(await reuseAudits(clientId)).toHaveLength(0);
        jest.restoreAllMocks();
        const replay = await refreshReq(clientId, rt);
        expect(replay.statusCode).toBe(400);
        expect(replay.json().error).toBe('invalid_grant');
        expect(replay.body).not.toMatch(/access_token|refresh_token/);
        const reuse = await reuseAudits(clientId);
        expect(reuse).toHaveLength(1);
        expect(reuse[0].metadata).toMatchObject({ count: 0 });
        expect(JSON.stringify(reuse[0])).not.toContain(rt);
        expect((await familyDocs(userId)).every((d) => d.revokedAt)).toBe(true);
      },
    );
  });
});
