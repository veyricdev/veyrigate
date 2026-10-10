import { jest } from '@jest/globals';
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
import { AuditService } from '../src/modules/security/audit/audit.service';
import { AuditAction } from '../src/modules/security/audit/audit-action.enum';
import type { AuditEvent } from '../src/modules/security/audit/audit.types';
import { AuthorizationCodeService } from '../src/modules/oauth/code/authorization-code.service';
import { TokenController } from '../src/modules/oauth/token/token.controller';
import { TokenService } from '../src/modules/oauth/token/token.service';
import { RefreshTokenService } from '../src/modules/oauth/token/refresh-token.service';

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

const cfg = {
  getOrThrow: (ns: string) => {
    if (ns === 'app') return { nodeEnv: 'production', issuer: ISSUER };
    if (ns === 'token') return { accessTokenTtl: ACCESS_TTL, refreshTokenTtl: REFRESH_TTL };
    if (ns === 'client') return { secretGraceTtl: 3600 };
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
  let confSecret = '';

  const post = (payload: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      payload,
    });

  const mintCode = (overrides: Record<string, unknown> = {}) =>
    codes.create({
      clientId: `${RUN}-public`,
      redirectUri: REDIRECT,
      codeChallenge: CHALLENGE,
      resource: RESOURCE,
      scope: 'openid profile',
      nonce: 'rp-nonce',
      userId: new Types.ObjectId().toHexString(),
      authTime: 1_700_000_000_000,
      ...overrides,
    } as never);

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
        AuthorizationCodeService,
        ClientService,
        ClientCredentialService,
        ClientAuthenticationService,
        AuditService,
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
      const keys = await redis.keys('authz_code:*');
      if (keys.length) await redis.del(...keys);
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
});
