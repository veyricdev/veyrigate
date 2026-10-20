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
import { UserService } from '../src/modules/identity/user.service';
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
  const lockOnly = (userId: string) =>
    conn
      .model('User')
      .updateOne(
        { _id: new Types.ObjectId(userId) },
        { $set: { lockedUntil: new Date(Date.now() + 3_600_000) } },
      );
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
});
