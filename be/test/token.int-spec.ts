import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import IORedis from 'ioredis';
import { decodeProtectedHeader } from 'jose';
import { Types, type Model } from 'mongoose';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { sha256 } from '../src/common/crypto/crypto.util';
import { deriveS256Challenge } from '../src/common/crypto/pkce.util';
import { RedisService } from '../src/database/redis/redis.service';
import { KEY_PROVIDER } from '../src/modules/keys/key-provider';
import { LocalKeyProvider } from '../src/modules/keys/local-key-provider';
import { TokenSigner } from '../src/modules/keys/token-signer';
import { TokenVerifier } from '../src/modules/keys/token-verifier';
import { ClientService, type Client } from '../src/modules/clients/client.service';
import { ClientCredentialService } from '../src/modules/clients/client-credential.service';
import { ClientAuthenticationService } from '../src/modules/clients/client-authentication.service';
import { ClientCorsService } from '../src/modules/clients/client-cors.service';
import { AuditService } from '../src/modules/security/audit/audit.service';
import { RateLimitService } from '../src/modules/security/rate-limit/rate-limit.service';
import { AuditAction } from '../src/modules/security/audit/audit-action.enum';
import type { AuditEvent } from '../src/modules/security/audit/audit.types';
import { AuthorizationCodeService } from '../src/modules/oauth/code/authorization-code.service';
import { SessionService } from '../src/modules/sessions/session.service';
import { TokenController } from '../src/modules/oauth/token/token.controller';
import { TokenService } from '../src/modules/oauth/token/token.service';
import { RefreshTokenService } from '../src/modules/oauth/token/refresh-token.service';
import { ResourceService } from '../src/modules/resources/resource.service';

const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-token-${Date.now()}?directConnection=true`;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';
const RUN = `tk${Date.now()}`;
const ISSUER = 'http://localhost:4000';
const ACCESS_TTL = 900;
const REFRESH_TTL = 2592000;
const REDIRECT = 'https://app.example.com/callback';
const RESOURCE = 'https://api.example.com/';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'; // 43 chars, RFC 7636 example
const CHALLENGE = deriveS256Challenge(VERIFIER);

const SESSION_IDLE_TTL = 28800;
const SESSION_ABSOLUTE_TTL = 2592000;

const cfg = {
  getOrThrow: (ns: string) => {
    if (ns === 'app') return { nodeEnv: 'production', issuer: ISSUER };
    if (ns === 'token')
      return {
        accessTokenTtl: ACCESS_TTL,
        refreshTokenTtl: REFRESH_TTL,
        sessionIdleTtl: SESSION_IDLE_TTL,
        sessionAbsoluteTtl: SESSION_ABSOLUTE_TTL,
      };
    if (ns === 'client') return { secretGraceTtl: 3600 };
    if (ns === 'security')
      return {
        rateLimitWindow: 60,
        rateLimitMax: 100,
        // High thresholds so the client-auth failure limiter never fires in these tests (the
        // dedicated spec sets small thresholds). Prevents cross-test 429 on the shared 127.0.0.1.
        clientAuthFailIpMax: 100000,
        clientAuthFailClientMax: 100000,
      };
    throw new Error(`unexpected ns ${ns}`);
  },
} as unknown as ConfigService;

function form(fields: Record<string, string | string[]>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    for (const item of Array.isArray(v) ? v : [v]) {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(item)}`);
    }
  }
  return parts.join('&');
}

describe('/token grant authorization_code on real Mongo + Redis (B4.4)', () => {
  let app: NestFastifyApplication;
  let redis: IORedis;
  let keyDir: string;
  let codes: AuthorizationCodeService;
  let verifier: TokenVerifier;
  let refreshModel: Model<Record<string, unknown>>;
  let auditModel: Model<AuditEvent>;
  let clientModel: Model<Client>;
  let clientService: ClientService;
  let sessions: SessionService;
  let confSecret = '';

  const post = (payload: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      payload,
    });

  /** Create a fresh, live IdP session and return its `ref` (sha256 of the raw id). */
  const liveSessionRef = async (): Promise<string> =>
    (await sessions.create(new Types.ObjectId().toHexString(), 'tenant-A')).session.ref;

  /**
   * Mint an authorization code bound to a LIVE session by default (DEBT-043: `/token` now refuses a
   * code whose session is not live). Pass `sessionRef` in overrides to bind a specific/dead session,
   * or `sessionRef: undefined` to simulate a pre-deploy code with no binding.
   */
  const mintCode = async (overrides: Record<string, unknown> = {}) => {
    const base: Record<string, unknown> = {
      clientId: `${RUN}-public`,
      redirectUri: REDIRECT,
      codeChallenge: CHALLENGE,
      resource: RESOURCE,
      scope: 'openid profile',
      nonce: 'rp-nonce',
      userId: new Types.ObjectId().toHexString(),
      authTime: 1_700_000_000_000,
      sessionRef: await liveSessionRef(),
    };
    return codes.create({ ...base, ...overrides } as never);
  };

  beforeAll(async () => {
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    keyDir = await mkdtemp(join(tmpdir(), 'vg-token-int-'));
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
      controllers: [TokenController],
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
        { provide: KEY_PROVIDER, useValue: provider },
        { provide: RedisService, useValue: new RedisService(redis) },
        { provide: ConfigService, useValue: cfg },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    codes = moduleRef.get(AuthorizationCodeService);
    sessions = moduleRef.get(SessionService);
    verifier = moduleRef.get(TokenVerifier);
    refreshModel = app.get<Model<Record<string, unknown>>>(getModelToken('RefreshToken'));
    auditModel = app.get<Model<AuditEvent>>(getModelToken('AuditLog'));

    const connection = refreshModel.db;
    await syncAllIndexes(connection);

    clientModel = app.get<Model<Client>>(getModelToken('Client'));
    clientService = new ClientService(clientModel, cfg);
    // public client (PKCE, auth method none)
    await clientService.create({
      clientId: `${RUN}-public`,
      clientType: 'public',
      tokenEndpointAuthMethod: 'none',
      redirectUris: [REDIRECT],
      grantTypes: ['authorization_code', 'refresh_token'],
      tenantId: 'tenant-A',
    });
    // a client WITHOUT the authorization_code grant
    await clientService.create({
      clientId: `${RUN}-nocodegrant`,
      clientType: 'public',
      tokenEndpointAuthMethod: 'none',
      redirectUris: [REDIRECT],
      grantTypes: ['refresh_token'],
      tenantId: 'tenant-A',
    });
    // a confidential client (client_secret_basic)
    const conf = await clientService.create({
      clientId: `${RUN}-conf`,
      clientType: 'confidential',
      tokenEndpointAuthMethod: 'client_secret_basic',
      redirectUris: [REDIRECT],
      grantTypes: ['authorization_code'],
      tenantId: 'tenant-A',
    });
    void conf;
    const creds = moduleRef.get(ClientCredentialService);
    const issued = await creds.createSecret(`${RUN}-conf`);
    confSecret = issued.secret;
  }, 60_000);

  afterAll(async () => {
    if (refreshModel) await refreshModel.db.dropDatabase();
    if (redis) {
      for (const pattern of ['authz_code:*', 'sess:*', 'sess_end:*', 'user_sess:*', 'sess_rp:*']) {
        const keys = await redis.keys(pattern);
        if (keys.length) await redis.del(...keys);
      }
      await redis.quit();
    }
    if (app) await app.close();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  it('happy path (public PKCE, offline_access): 200 with all tokens + no-store', async () => {
    const { code } = await mintCode({ scope: 'openid profile offline_access' });
    const res = await post(
      form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: `${RUN}-public`,
        code_verifier: VERIFIER,
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['pragma']).toBe('no-cache');
    const body = res.json();
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(ACCESS_TTL);
    expect(body.scope).toBe('openid profile offline_access');
    expect(body.access_token).toBeDefined();
    expect(body.id_token).toBeDefined();
    expect(body.refresh_token).toBeDefined();
    const payload = await verifier.verify(body.access_token, RESOURCE);
    expect(payload.aud).toBe(RESOURCE);

    const docs = await refreshModel.find({ tokenHash: sha256(body.refresh_token) }).lean();
    expect(docs).toHaveLength(1);
  });

  it('access token header is typ=at+jwt, id token header is typ=JWT (RFC 9068, token confusion)', async () => {
    // Decode the protected header of the tokens the REAL `/token` endpoint emits (not a signer unit
    // double): the access token MUST carry `typ: at+jwt` so `/userinfo`/`/introspect` can reject an
    // ID token (`typ: JWT`) replayed as an access token. Both are RS256 from the same signer.
    const { code } = await mintCode({ scope: 'openid' });
    const res = await post(
      form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: `${RUN}-public`,
        code_verifier: VERIFIER,
      }),
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(decodeProtectedHeader(body.access_token)).toMatchObject({ alg: 'RS256', typ: 'at+jwt' });
    expect(decodeProtectedHeader(body.id_token)).toMatchObject({ alg: 'RS256', typ: 'JWT' });
  });

  it('grant_type != authorization_code => 400 unsupported_grant_type', async () => {
    const res = await post(form({ grant_type: 'client_credentials', client_id: `${RUN}-public` }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unsupported_grant_type');
  });

  it('wrong client secret => 401 invalid_client + WWW-Authenticate; code NOT consumed, then valid 200', async () => {
    const { code } = await mintCode({ clientId: `${RUN}-conf` });
    const bad = Buffer.from(`${RUN}-conf:wrong-secret`).toString('base64');
    const res = await post(
      form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      }),
      { authorization: `Basic ${bad}` },
    );
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_client');
    expect(res.headers['www-authenticate']).toMatch(/^Basic/);
    expect(res.headers['cache-control']).toBe('no-store');

    // code survived: a correct exchange still works.
    const good = Buffer.from(`${RUN}-conf:${confSecret}`).toString('base64');
    const ok = await post(
      form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      }),
      { authorization: `Basic ${good}` },
    );
    expect(ok.statusCode).toBe(200);
  });

  it('client without authorization_code grant => 400 unauthorized_client (code intact)', async () => {
    const { code } = await mintCode({ clientId: `${RUN}-nocodegrant` });
    const res = await post(
      form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: `${RUN}-nocodegrant`,
        code_verifier: VERIFIER,
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unauthorized_client');
    expect(await redis.exists(`authz_code:${sha256(code)}`)).toBe(1);
  });

  it('wrong code_verifier => 400 invalid_grant and code INTACT (INV-13), then correct verifier => 200', async () => {
    const { code } = await mintCode();
    const wrongVerifier = 'wrongwrongwrongwrongwrongwrongwrongwrongwrong'; // 45 chars valid format
    const res = await post(
      form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: `${RUN}-public`,
        code_verifier: wrongVerifier,
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_grant');
    expect(await redis.exists(`authz_code:${sha256(code)}`)).toBe(1);

    const ok = await post(
      form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: `${RUN}-public`,
        code_verifier: VERIFIER,
      }),
    );
    expect(ok.statusCode).toBe(200);
  });

  it('malformed code_verifier (bad format) => 400 invalid_grant, code never read from Redis', async () => {
    const { code } = await mintCode();
    const res = await post(
      form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: `${RUN}-public`,
        code_verifier: 'short',
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_grant');
    expect(await redis.exists(`authz_code:${sha256(code)}`)).toBe(1);
    await codes.consume(code, `${RUN}-public`, REDIRECT, CHALLENGE);
  });

  it('wrong redirect_uri => 400 invalid_grant, code intact (INV-13)', async () => {
    const { code } = await mintCode();
    const res = await post(
      form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://evil.example.com/cb',
        client_id: `${RUN}-public`,
        code_verifier: VERIFIER,
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_grant');
    expect(await redis.exists(`authz_code:${sha256(code)}`)).toBe(1);
    await codes.consume(code, `${RUN}-public`, REDIRECT, CHALLENGE);
  });

  it('unknown/already-used code => 400 invalid_grant', async () => {
    const { code } = await mintCode();
    const first = await post(
      form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: `${RUN}-public`,
        code_verifier: VERIFIER,
      }),
    );
    expect(first.statusCode).toBe(200);
    const second = await post(
      form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: `${RUN}-public`,
        code_verifier: VERIFIER,
      }),
    );
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toBe('invalid_grant');
  });

  it('code bound to no resource => 400 invalid_target, no id/access token, no refresh doc', async () => {
    const { code } = await mintCode({ resource: undefined, scope: 'openid offline_access' });
    const res = await post(
      form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: `${RUN}-public`,
        code_verifier: VERIFIER,
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_target');
    expect(res.json().access_token).toBeUndefined();
    const docs = await refreshModel.find({ clientId: `${RUN}-public` }).lean();
    // this code never minted a refresh token.
    expect(
      docs.every((d) => d.scope && (d.scope as string[]).includes('openid offline_access')),
    ).toBe(false);
  });

  it('no openid scope => 200 but no id_token', async () => {
    const { code } = await mintCode({ scope: 'profile' });
    const res = await post(
      form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: `${RUN}-public`,
        code_verifier: VERIFIER,
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().id_token).toBeUndefined();
  });

  it('no offline_access => 200 but no refresh_token', async () => {
    const { code } = await mintCode({ scope: 'openid profile' });
    const res = await post(
      form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: `${RUN}-public`,
        code_verifier: VERIFIER,
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().refresh_token).toBeUndefined();
  });

  it('wrong content-type => 400 invalid_request', async () => {
    const { code } = await mintCode();
    const res = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ grant_type: 'authorization_code', code }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
    await codes.consume(code, `${RUN}-public`, REDIRECT, CHALLENGE);
  });

  it('repeated parameter => 400 invalid_request', async () => {
    const res = await post(
      form({
        grant_type: ['authorization_code', 'authorization_code'],
        client_id: `${RUN}-public`,
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
  });

  it('body client_id disagrees with Basic => 401 invalid_client', async () => {
    const basic = Buffer.from(`${RUN}-conf:${confSecret}`).toString('base64');
    const res = await post(
      form({
        grant_type: 'authorization_code',
        code: 'x',
        redirect_uri: REDIRECT,
        client_id: 'other',
        code_verifier: VERIFIER,
      }),
      { authorization: `Basic ${basic}` },
    );
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_client');
  });

  it('both Basic and client_secret body => 400 invalid_request', async () => {
    const basic = Buffer.from(`${RUN}-conf:${confSecret}`).toString('base64');
    const res = await post(
      form({
        grant_type: 'authorization_code',
        code: 'x',
        redirect_uri: REDIRECT,
        client_secret: 'y',
        code_verifier: VERIFIER,
      }),
      { authorization: `Basic ${basic}` },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
  });

  it('missing client_id entirely => 401 invalid_client', async () => {
    const res = await post(
      form({
        grant_type: 'authorization_code',
        code: 'x',
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      }),
    );
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_client');
  });

  it('resource in body != bound resource => 400 invalid_target', async () => {
    const { code } = await mintCode();
    const res = await post(
      form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: `${RUN}-public`,
        code_verifier: VERIFIER,
        resource: 'https://other.example.com/',
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_target');
    await codes.consume(code, `${RUN}-public`, REDIRECT, CHALLENGE);
  });

  it('TOKEN_ISSUED audit written with safe metadata (INV-25)', async () => {
    const before = await auditModel.countDocuments({ action: AuditAction.TOKEN_ISSUED });
    const { code } = await mintCode({ scope: 'openid profile offline_access' });
    const res = await post(
      form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: `${RUN}-public`,
        code_verifier: VERIFIER,
      }),
    );
    expect(res.statusCode).toBe(200);
    const events = await auditModel.find({ action: AuditAction.TOKEN_ISSUED }).lean();
    expect(events.length).toBeGreaterThan(before);
    const flat = JSON.stringify(events);
    expect(flat).not.toContain(res.json().access_token);
    expect(flat).not.toContain(res.json().refresh_token);
    // DEBT-068: metadata.refresh reflects the family actually minted (offline_access => true).
    const success = events.filter(
      (e) =>
        e.result === 'success' &&
        (e.metadata as { scope?: string }).scope?.includes('offline_access'),
    );
    expect(success.length).toBeGreaterThan(0);
    expect((success.at(-1)?.metadata as { refresh?: boolean }).refresh).toBe(true);
  });

  it('DEBT-068: TOKEN_ISSUED metadata.refresh=false when no offline_access (no family minted)', async () => {
    const u = new Types.ObjectId().toHexString();
    const { code } = await mintCode({ scope: 'openid profile', userId: u });
    const res = await post(
      form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: `${RUN}-public`,
        code_verifier: VERIFIER,
      }),
    );
    expect(res.statusCode).toBe(200);
    const events = await auditModel
      .find({ action: AuditAction.TOKEN_ISSUED, actorId: u, result: 'success' })
      .lean();
    expect(events).toHaveLength(1);
    expect((events[0].metadata as { refresh?: boolean }).refresh).toBe(false);
  });

  it('two concurrent exchanges of the same code => exactly one 200, one DB refresh doc', async () => {
    const { code } = await mintCode({ scope: 'openid offline_access' });
    const payload = form({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: `${RUN}-public`,
      code_verifier: VERIFIER,
    });
    const [a, b] = await Promise.all([post(payload), post(payload)]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([200, 400]);
    const docs = await refreshModel.find({ tokenHash: { $exists: true } }).lean();
    const winner = a.statusCode === 200 ? a : b;
    const mine = docs.filter((d) => d.tokenHash === sha256(winner.json().refresh_token));
    expect(mine).toHaveLength(1);
  });

  it('malformed percent-encoding in Basic credentials => 401 invalid_client + WWW-Authenticate', async () => {
    const basic = Buffer.from('%ZZ:x').toString('base64');
    const res = await post(
      form({
        grant_type: 'authorization_code',
        code: 'x',
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      }),
      { authorization: `Basic ${basic}` },
    );
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_client');
    expect(res.headers['www-authenticate']).toMatch(/^Basic/);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  // --- Failure semantics: infrastructure error => fail-closed 500, no token, no leak (INV-25). ---

  it('Redis consume error => 500 server_error + no-store, no token/code leak', async () => {
    const { code } = await mintCode({ scope: 'openid profile offline_access' });
    const spy = jest
      .spyOn(codes, 'consume')
      .mockRejectedValueOnce(new Error('redis down: SECRET-detail'));
    try {
      const res = await post(
        form({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT,
          client_id: `${RUN}-public`,
          code_verifier: VERIFIER,
        }),
      );
      expect(res.statusCode).toBe(500);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = res.json();
      expect(body.error).toBe('server_error');
      expect(body.access_token).toBeUndefined();
      expect(body.id_token).toBeUndefined();
      const flat = JSON.stringify(body);
      expect(flat).not.toContain(code);
      expect(flat).not.toContain(VERIFIER);
      expect(flat).not.toContain('SECRET-detail');
    } finally {
      spy.mockRestore();
    }
  });

  it('RefreshToken insert error (offline_access) => 500, body has no access_token/id_token/refresh_token', async () => {
    const { code } = await mintCode({ scope: 'openid profile offline_access' });
    const spy = jest
      .spyOn(refreshModel, 'create')
      .mockRejectedValueOnce(new Error('mongo write failed: SECRET-detail') as never);
    try {
      const res = await post(
        form({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT,
          client_id: `${RUN}-public`,
          code_verifier: VERIFIER,
        }),
      );
      expect(res.statusCode).toBe(500);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = res.json();
      expect(body.error).toBe('server_error');
      expect(body.access_token).toBeUndefined();
      expect(body.id_token).toBeUndefined();
      expect(body.refresh_token).toBeUndefined();
      const flat = JSON.stringify(body);
      expect(flat).not.toContain(code);
      expect(flat).not.toContain(VERIFIER);
      expect(flat).not.toContain('SECRET-detail');
    } finally {
      spy.mockRestore();
    }
  });

  it('TokenSigner.sign error => 500 server_error, no token/code/verifier leak', async () => {
    const { code } = await mintCode({ scope: 'openid profile' });
    const signer = app.get(TokenSigner);
    const spy = jest
      .spyOn(signer, 'sign')
      .mockRejectedValue(new Error('signer failure: SECRET-detail'));
    try {
      const res = await post(
        form({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT,
          client_id: `${RUN}-public`,
          code_verifier: VERIFIER,
        }),
      );
      expect(res.statusCode).toBe(500);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = res.json();
      expect(body.error).toBe('server_error');
      expect(body.access_token).toBeUndefined();
      expect(body.id_token).toBeUndefined();
      const flat = JSON.stringify(body);
      expect(flat).not.toContain(code);
      expect(flat).not.toContain(VERIFIER);
      expect(flat).not.toContain('SECRET-detail');
    } finally {
      spy.mockRestore();
    }
  });

  // QA (run 13): Task 1 fold — a legacy client stored without `grantTypes` (pre-B4.4 doc, bypassing
  // Mongoose defaults via a raw insert) must normalise to ['authorization_code'] end-to-end so
  // `/token` serves it (NOT a 500 from `client.grantTypes` being undefined).
  it('legacy client without grantTypes field: /token exchange succeeds (no 500)', async () => {
    const legacyId = `${RUN}-legacy`;
    await clientModel.collection.insertOne({
      clientId: legacyId,
      clientType: 'public',
      tokenEndpointAuthMethod: 'none',
      redirectUris: [REDIRECT],
      postLogoutRedirectUris: [],
      allowedCorsOrigins: [],
      allowedResources: [],
      scopes: [],
      tenantId: 'tenant-A',
    });
    const { code } = await mintCode({ clientId: legacyId, scope: 'openid profile' });
    const res = await post(
      form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: legacyId,
        code_verifier: VERIFIER,
      }),
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.access_token).toBeDefined();
    // grantTypes defaulted to ['authorization_code'] only => no refresh even though no offline_access.
    expect(body.refresh_token).toBeUndefined();
  });

  describe('session binding: sid on access token + logout gate (DEBT-037/043)', () => {
    const exchange = (code: string) =>
      post(
        form({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT,
          client_id: `${RUN}-public`,
          code_verifier: VERIFIER,
        }),
      );

    const decodeSid = (jwt: string): unknown =>
      JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).sid;

    it('DEBT-037 (a): the minted access token carries sid === the code session ref', async () => {
      const ref = (await sessions.create(new Types.ObjectId().toHexString(), 'tenant-A')).session
        .ref;
      const { code } = await mintCode({ scope: 'openid profile offline_access', sessionRef: ref });
      const res = await exchange(code);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(decodeSid(body.access_token)).toBe(ref);
      // The refresh family also records the ref so a later rotation keeps the same sid.
      const [doc] = await refreshModel
        .find({ tokenHash: sha256(body.refresh_token) })
        .lean<{ sessionRef?: string }[]>();
      expect(doc.sessionRef).toBe(ref);
    });

    it('DEBT-043: global logout of the session => code no longer exchangeable (invalid_grant, no token)', async () => {
      const u = new Types.ObjectId().toHexString();
      const ref = (await sessions.create(u, 'tenant-A')).session.ref;
      const { code } = await mintCode({ scope: 'openid offline_access', sessionRef: ref });
      await sessions.revokeAllForUser(u); // "log out everywhere" before the code is redeemed

      const res = await exchange(code);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_grant');
      // Nothing minted: no refresh family for this code's user.
      const count = await refreshModel.countDocuments({ userId: new Types.ObjectId(u) });
      expect(count).toBe(0);
      // Single-use preserved: the code was consumed, so a retry is still invalid_grant.
      expect((await exchange(code)).json().error).toBe('invalid_grant');
    });

    it('DEBT-043: a session idle-expired (sess key gone, NOT via revoke) => invalid_grant', async () => {
      // Bind the code to a ref that has no live `sess:{ref}` (simulates idle/absolute expiry, which
      // leaves no tombstone). The user must re-authenticate — the code cannot be redeemed.
      const ref = sha256(`gone-${Date.now()}`);
      const { code } = await mintCode({ scope: 'openid offline_access', sessionRef: ref });
      const res = await exchange(code);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_grant');
    });

    it('DEBT-043: a code with NO sessionRef (pre-deploy) => invalid_grant, fail-closed', async () => {
      const { code } = await mintCode({ scope: 'openid', sessionRef: undefined });
      const res = await exchange(code);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_grant');
    });

    it('DEBT-043: a live session => the code still exchanges successfully (no regression)', async () => {
      const ref = (await sessions.create(new Types.ObjectId().toHexString(), 'tenant-A')).session
        .ref;
      const { code } = await mintCode({ scope: 'openid profile', sessionRef: ref });
      const res = await exchange(code);
      expect(res.statusCode).toBe(200);
      expect(res.json().access_token).toBeDefined();
    });
  });

  describe('DEBT-059: TOKEN_ISSUED audit reflects the post-insert re-check (INV-25/29)', () => {
    const exchange = (code: string) =>
      post(
        form({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT,
          client_id: `${RUN}-public`,
          code_verifier: VERIFIER,
        }),
      );

    afterEach(() => jest.restoreAllMocks());

    it('session ends between re-check (exists true=>false), offline_access => 0 success, 1 failure session_ended, family revoked', async () => {
      const u = new Types.ObjectId().toHexString();
      const ref = (await sessions.create(u, 'tenant-A')).session.ref;
      const { code } = await mintCode({
        scope: 'openid offline_access',
        sessionRef: ref,
        userId: u,
      });
      // exists(): first call (pre-mint) true, second call (post-insert re-check) false — a logout
      // slipped into the exchange window (TOCTOU).
      jest.spyOn(sessions, 'exists').mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      const res = await exchange(code);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_grant');
      expect(res.json().access_token).toBeUndefined();

      const issued = await auditModel.find({ action: AuditAction.TOKEN_ISSUED, actorId: u }).lean();
      // Exactly one TOKEN_ISSUED, and it is a failure:session_ended (no false "success").
      expect(issued.filter((e) => e.result === 'success')).toHaveLength(0);
      const failures = issued.filter((e) => e.result === 'failure');
      expect(failures).toHaveLength(1);
      expect(failures[0].reason).toBe('session_ended');
      // The family minted before the re-check is revoked (TOKEN_REVOKED session_ended), none orphaned.
      const fams = await refreshModel
        .find({ userId: new Types.ObjectId(u) })
        .lean<{ familyRevokedAt?: Date | null }[]>();
      expect(fams.length).toBeGreaterThan(0);
      for (const f of fams) expect(f.familyRevokedAt).toBeTruthy();
      const revoked = await auditModel
        .find({ action: AuditAction.TOKEN_REVOKED, clientId: `${RUN}-public` })
        .lean();
      expect(
        revoked.some((e) => (e.metadata as { reason?: string }).reason === 'session_ended'),
      ).toBe(true);
    });

    it('session ends between re-check, NO offline_access => 0 success, 1 failure session_ended, no family/TOKEN_REVOKED', async () => {
      const u = new Types.ObjectId().toHexString();
      const ref = (await sessions.create(u, 'tenant-A')).session.ref;
      const { code } = await mintCode({ scope: 'openid profile', sessionRef: ref, userId: u });
      jest.spyOn(sessions, 'exists').mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      const res = await exchange(code);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_grant');

      const issued = await auditModel.find({ action: AuditAction.TOKEN_ISSUED, actorId: u }).lean();
      expect(issued.filter((e) => e.result === 'success')).toHaveLength(0);
      const failures = issued.filter((e) => e.result === 'failure');
      expect(failures).toHaveLength(1);
      expect(failures[0].reason).toBe('session_ended');
      // No family minted => no refresh doc and no TOKEN_REVOKED for this user.
      expect(await refreshModel.countDocuments({ userId: new Types.ObjectId(u) })).toBe(0);
    });

    it('Redis error on the re-check => 500, 0 TOKEN_ISSUED success for the request', async () => {
      const u = new Types.ObjectId().toHexString();
      const ref = (await sessions.create(u, 'tenant-A')).session.ref;
      const { code } = await mintCode({
        scope: 'openid offline_access',
        sessionRef: ref,
        userId: u,
      });
      jest
        .spyOn(sessions, 'exists')
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error('redis down'));

      const res = await exchange(code);
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('server_error');
      expect(res.json().access_token).toBeUndefined();

      const issued = await auditModel.find({ action: AuditAction.TOKEN_ISSUED, actorId: u }).lean();
      expect(issued.filter((e) => e.result === 'success')).toHaveLength(0);
    });

    it('DEBT-067: revoke throws in the !live branch => still exactly 1 TOKEN_ISSUED failure session_ended, 0 success, 500', async () => {
      const u = new Types.ObjectId().toHexString();
      const ref = (await sessions.create(u, 'tenant-A')).session.ref;
      const { code } = await mintCode({
        scope: 'openid offline_access',
        sessionRef: ref,
        userId: u,
      });
      // exists(): pre-mint true, post-insert re-check false (session ended in the window).
      jest.spyOn(sessions, 'exists').mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      // The family revoke for the ended session throws (Mongo down): the audit of the refusal must
      // still be written (best-effort) before the original error propagates.
      const refreshService = app.get(RefreshTokenService);
      jest
        .spyOn(refreshService, 'revokeFamilyForEndedSession')
        .mockRejectedValueOnce(new Error('db down'));

      const res = await exchange(code);
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('server_error');
      expect(res.json().access_token).toBeUndefined();
      expect(res.json().refresh_token).toBeUndefined();

      const issued = await auditModel.find({ action: AuditAction.TOKEN_ISSUED, actorId: u }).lean();
      expect(issued.filter((e) => e.result === 'success')).toHaveLength(0);
      const failures = issued.filter((e) => e.result === 'failure');
      expect(failures).toHaveLength(1);
      expect(failures[0].reason).toBe('session_ended');
    });

    it('DEBT-067: revoke AND the failure-audit both throw => still 500; the ORIGINAL revoke error propagates (audit error swallowed)', async () => {
      const u = new Types.ObjectId().toHexString();
      const ref = (await sessions.create(u, 'tenant-A')).session.ref;
      const { code } = await mintCode({
        scope: 'openid offline_access',
        sessionRef: ref,
        userId: u,
      });
      jest.spyOn(sessions, 'exists').mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const refreshService = app.get(RefreshTokenService);
      const revokeSpy = jest
        .spyOn(refreshService, 'revokeFamilyForEndedSession')
        .mockRejectedValueOnce(new Error('revoke db down'));
      // The best-effort refusal audit ALSO throws: it must be swallowed, never masking the revoke
      // error and never changing the 500 outcome.
      const tokens = app.get(TokenService);
      const recordSpy = jest
        .spyOn(tokens, 'recordIssued')
        .mockRejectedValueOnce(new Error('audit db down'));

      const res = await exchange(code);
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('server_error');
      expect(res.json().access_token).toBeUndefined();
      expect(res.json().refresh_token).toBeUndefined();
      // Both best-effort writes were attempted; the audit throw did not short-circuit the flow.
      expect(revokeSpy).toHaveBeenCalledTimes(1);
      expect(recordSpy).toHaveBeenCalledTimes(1);
    });

    it('audit of success fails after a live re-check => 500, no token, minted family revoked', async () => {
      const u = new Types.ObjectId().toHexString();
      const ref = (await sessions.create(u, 'tenant-A')).session.ref;
      const { code } = await mintCode({
        scope: 'openid offline_access',
        sessionRef: ref,
        userId: u,
      });
      // Session stays live through both reads; the TOKEN_ISSUED success write then fails.
      jest.spyOn(sessions, 'exists').mockResolvedValue(true);
      const tokens = app.get(TokenService);
      jest.spyOn(tokens, 'recordIssued').mockRejectedValueOnce(new Error('audit mongo down'));

      const res = await exchange(code);
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('server_error');
      expect(res.json().access_token).toBeUndefined();

      const fams = await refreshModel
        .find({ userId: new Types.ObjectId(u) })
        .lean<{ familyRevokedAt?: Date | null }[]>();
      expect(fams.length).toBeGreaterThan(0);
      for (const f of fams) expect(f.familyRevokedAt).toBeTruthy();
    });
  });
});
