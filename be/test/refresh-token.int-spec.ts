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
  `mongodb://localhost:27117/vg-int-refresh-${Date.now()}?directConnection=true`;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';
const RUN = `rt${Date.now()}`;
const ISSUER = 'http://localhost:4000';
const ACCESS_TTL = 900;
const REFRESH_TTL = 2592000;
const REDIRECT = 'https://app.example.com/callback';
const RESOURCE = 'https://api.example.com/';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
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

/** Decode a JWT payload (test-only, no signature check). */
function decodeJwt(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
}

describe('refresh grant + rotation + reuse + /revoke on real Mongo + Redis (B4.5)', () => {
  let app: NestFastifyApplication;
  let redis: IORedis;
  let keyDir: string;
  let codes: AuthorizationCodeService;
  let refreshSvc: RefreshTokenService;
  let tokenSvc: TokenService;
  let verifier: TokenVerifier;
  let refreshModel: Model<Record<string, unknown>>;
  let auditModel: Model<AuditEvent>;
  let clientModel: Model<Client>;

  const CLIENT = `${RUN}-public`;
  const CLIENT_B = `${RUN}-other`;
  const CLIENT_NO_REFRESH = `${RUN}-norefresh`;

  const post = (url: string, payload: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      payload,
    });

  const mintCode = (overrides: Record<string, unknown> = {}) =>
    codes.create({
      clientId: CLIENT,
      redirectUri: REDIRECT,
      codeChallenge: CHALLENGE,
      resource: RESOURCE,
      scope: 'openid profile offline_access',
      nonce: 'rp-nonce',
      userId: new Types.ObjectId().toHexString(),
      authTime: 1_700_000_000_000,
      ...overrides,
    } as never);

  /** Run the authorization_code flow once and return the first refresh token of a fresh family. */
  async function firstRefresh(
    clientId = CLIENT,
    scope = 'openid profile offline_access',
  ): Promise<string> {
    const { code } = await mintCode({ clientId, scope });
    const res = await post(
      '/token',
      form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: VERIFIER,
      }),
    );
    expect(res.statusCode).toBe(200);
    return res.json().refresh_token as string;
  }

  const refreshReq = (token: string, extra: Record<string, string> = {}) =>
    post('/token', form({ grant_type: 'refresh_token', client_id: CLIENT, refresh_token: token, ...extra }));

  beforeAll(async () => {
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    keyDir = await mkdtemp(join(tmpdir(), 'vg-refresh-int-'));
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
    refreshSvc = moduleRef.get(RefreshTokenService);
    tokenSvc = moduleRef.get(TokenService);
    verifier = moduleRef.get(TokenVerifier);
    refreshModel = app.get<Model<Record<string, unknown>>>(getModelToken('RefreshToken'));
    auditModel = app.get<Model<AuditEvent>>(getModelToken('AuditLog'));
    await syncAllIndexes(refreshModel.db);

    clientModel = app.get<Model<Client>>(getModelToken('Client'));
    const clientService = new ClientService(clientModel, cfg);
    await clientService.create({
      clientId: CLIENT,
      clientType: 'public',
      tokenEndpointAuthMethod: 'none',
      redirectUris: [REDIRECT],
      grantTypes: ['authorization_code', 'refresh_token'],
      allowedResources: [RESOURCE],
      tenantId: 'tenant-A',
    });
    await clientService.create({
      clientId: CLIENT_B,
      clientType: 'public',
      tokenEndpointAuthMethod: 'none',
      redirectUris: [REDIRECT],
      grantTypes: ['authorization_code', 'refresh_token'],
      allowedResources: [RESOURCE],
      tenantId: 'tenant-A',
    });
    await clientService.create({
      clientId: CLIENT_NO_REFRESH,
      clientType: 'public',
      tokenEndpointAuthMethod: 'none',
      redirectUris: [REDIRECT],
      grantTypes: ['authorization_code'],
      allowedResources: [RESOURCE],
      tenantId: 'tenant-A',
    });
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

  // ----- Task 3: /token grant refresh_token -----

  it('happy path: refresh => 200, new access(aud=resource)+refresh, no-store, audit TOKEN_REFRESHED', async () => {
    const rt = await firstRefresh();
    const res = await refreshReq(rt);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body.token_type).toBe('Bearer');
    expect(body.scope).toBe('openid profile offline_access');
    expect(body.refresh_token).toBeDefined();
    expect(body.refresh_token).not.toBe(rt);
    const payload = await verifier.verify(body.access_token, RESOURCE);
    expect(payload.aud).toBe(RESOURCE);

    const audits = await auditModel
      .find({ action: AuditAction.TOKEN_REFRESHED })
      .lean();
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const meta = audits[audits.length - 1].metadata as Record<string, unknown>;
    expect(JSON.stringify(meta)).not.toContain(rt);
    expect(JSON.stringify(meta)).not.toContain(sha256(rt));

    // old doc revoked + replacedBy is the successor _id; descendant active, same family.
    const oldDoc = await refreshModel.findOne({ tokenHash: sha256(rt) }).lean<Record<string, unknown>>();
    const newDoc = await refreshModel.findOne({ tokenHash: sha256(body.refresh_token) }).lean<Record<string, unknown>>();
    expect(oldDoc!.revokedAt).toBeTruthy();
    expect(String(oldDoc!.replacedBy)).toBe(String(newDoc!._id));
    expect(String(newDoc!.parentId)).toBe(String(oldDoc!._id));
    expect(newDoc!.familyId).toBe(oldDoc!.familyId);
    // absolute lifetime inherited (no sliding).
    expect(new Date(newDoc!.expiresAt as string).getTime()).toBe(
      new Date(oldDoc!.expiresAt as string).getTime(),
    );
  });

  it('id token from refresh has no nonce / no auth_time; admin-less access token has no auth_time', async () => {
    const rt = await firstRefresh();
    const res = await refreshReq(rt);
    const body = res.json();
    const id = decodeJwt(body.id_token);
    expect(id.nonce).toBeUndefined();
    expect(id.auth_time).toBeUndefined();
    const at = decodeJwt(body.access_token);
    expect(at.auth_time).toBeUndefined();
  });

  it('narrowing scope drops openid => response has no id_token; refresh keeps original scope', async () => {
    const rt = await firstRefresh();
    const res = await refreshReq(rt, { scope: 'profile' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scope).toBe('profile');
    expect(body.id_token).toBeUndefined();
    // descendant refresh keeps the ORIGINAL grant scope (INV-12).
    const newDoc = await refreshModel.findOne({ tokenHash: sha256(body.refresh_token) }).lean<Record<string, unknown>>();
    expect((newDoc!.scope as string[]).sort()).toEqual(['offline_access', 'openid', 'profile']);
  });

  it('scope escalation (scope outside original) => 400 invalid_scope, NOT rotated (token still active)', async () => {
    const rt = await firstRefresh();
    const res = await refreshReq(rt, { scope: 'openid profile admin' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_scope');
    // token untouched.
    const doc = await refreshModel.findOne({ tokenHash: sha256(rt) }).lean<Record<string, unknown>>();
    expect(doc!.revokedAt).toBeFalsy();
    expect(doc!.replacedBy).toBeFalsy();
    // still usable afterwards.
    const ok = await refreshReq(rt);
    expect(ok.statusCode).toBe(200);
  });

  it('empty scope (scope=) => treated as no scope: keeps original grant, 200 with full scope', async () => {
    const rt = await firstRefresh();
    const res = await refreshReq(rt, { scope: '' });
    expect(res.statusCode).toBe(200);
    expect(res.json().scope).toBe('openid profile offline_access');
  });

  it('duplicated scope tokens are deduped in the access-token scope', async () => {
    const rt = await firstRefresh();
    const res = await refreshReq(rt, { scope: 'profile profile openid' });
    expect(res.statusCode).toBe(200);
    expect((res.json().scope as string).split(' ').sort()).toEqual(['openid', 'profile']);
  });

  it('replay a ROTATED refresh WITH a bad scope => invalid_grant + family revoked + reuse alert (not invalid_scope)', async () => {
    // 🟡-1: the pre-check must only consider ACTIVE tokens so a replay of a rotated value still
    // triggers reuse detection even if the body carries an out-of-scope value (no silenced alarm).
    const rt = await firstRefresh();
    await refreshReq(rt); // rotate once → rt is now revoked+replaced.
    const familyId = (await refreshModel.findOne({ tokenHash: sha256(rt) }).lean<Record<string, unknown>>())!
      .familyId as string;
    const before = await auditModel.countDocuments({
      action: AuditAction.TOKEN_REUSE_DETECTED,
      'metadata.familyId': familyId,
    });

    const replay = await refreshReq(rt, { scope: 'openid profile admin' });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe('invalid_grant');

    const all = await refreshModel.find({ familyId }).lean<Record<string, unknown>[]>();
    expect(all.every((d) => d.revokedAt)).toBe(true);
    const after = await auditModel.countDocuments({
      action: AuditAction.TOKEN_REUSE_DETECTED,
      'metadata.familyId': familyId,
    });
    expect(after).toBe(before + 1);
  });

  it('body resource different from bound resource => 400 invalid_target, not rotated', async () => {
    const rt = await firstRefresh();
    const res = await refreshReq(rt, { resource: 'https://other.example.com/' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_target');
    const doc = await refreshModel.findOne({ tokenHash: sha256(rt) }).lean<Record<string, unknown>>();
    expect(doc!.revokedAt).toBeFalsy();
  });

  it('cross-client: refresh of client A used by client B => invalid_grant, A untouched, A family NOT revoked', async () => {
    const rt = await firstRefresh(CLIENT);
    const res = await post('/token', form({ grant_type: 'refresh_token', client_id: CLIENT_B, refresh_token: rt }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_grant');
    const doc = await refreshModel.findOne({ tokenHash: sha256(rt) }).lean<Record<string, unknown>>();
    expect(doc!.revokedAt).toBeFalsy();
    expect(doc!.replacedBy).toBeFalsy();
    // A can still use it (family not torn down by a foreign client's probe).
    const ok = await refreshReq(rt);
    expect(ok.statusCode).toBe(200);
  });

  it('reuse: replay a rotated refresh => 400 invalid_grant + whole family revoked + TOKEN_REUSE_DETECTED', async () => {
    const rt = await firstRefresh();
    const first = await refreshReq(rt);
    const familyDoc = await refreshModel.findOne({ tokenHash: sha256(rt) }).lean<Record<string, unknown>>();
    const familyId = familyDoc!.familyId as string;

    const replay = await refreshReq(rt);
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe('invalid_grant');

    const all = await refreshModel.find({ familyId }).lean<Record<string, unknown>[]>();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.every((d) => d.revokedAt)).toBe(true);

    const alerts = await auditModel.find({ action: AuditAction.TOKEN_REUSE_DETECTED }).lean();
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    // the once-valid descendant is now dead too (strict rotation => re-login).
    const dead = await refreshReq(first.json().refresh_token);
    expect(dead.statusCode).toBe(400);
  });

  it('expired refresh => invalid_grant, family NOT revoked, no reuse audit', async () => {
    const rt = await firstRefresh();
    await refreshModel.updateOne(
      { tokenHash: sha256(rt) },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const doc = await refreshModel.findOne({ tokenHash: sha256(rt) }).lean<Record<string, unknown>>();
    const familyId = doc!.familyId as string;
    const before = await auditModel.countDocuments({
      action: AuditAction.TOKEN_REUSE_DETECTED,
      'metadata.familyId': familyId,
    });

    const res = await refreshReq(rt);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_grant');
    const after = await refreshModel.find({ familyId }).lean<Record<string, unknown>[]>();
    expect(after.every((d) => !d.revokedAt)).toBe(true);
    const reuse = await auditModel.countDocuments({
      action: AuditAction.TOKEN_REUSE_DETECTED,
      'metadata.familyId': familyId,
    });
    expect(reuse).toBe(before);
  });

  it('unknown token value => invalid_grant, no reuse audit, no family revoked', async () => {
    const before = await auditModel.countDocuments({ action: AuditAction.TOKEN_REUSE_DETECTED });
    const res = await refreshReq('this-is-not-a-real-token');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_grant');
    const after = await auditModel.countDocuments({ action: AuditAction.TOKEN_REUSE_DETECTED });
    expect(after).toBe(before);
  });

  it('resource removed from client.allowedResources => invalid_grant, doc unchanged, family not revoked', async () => {
    const rt = await firstRefresh();
    await clientModel.updateOne({ clientId: CLIENT }, { $set: { allowedResources: [] } });
    try {
      const res = await refreshReq(rt);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_grant');
      const doc = await refreshModel.findOne({ tokenHash: sha256(rt) }).lean<Record<string, unknown>>();
      expect(doc!.revokedAt).toBeFalsy();
    } finally {
      await clientModel.updateOne({ clientId: CLIENT }, { $set: { allowedResources: [RESOURCE] } });
    }
  });

  it('client without refresh_token grant => 400 unauthorized_client; missing refresh_token => invalid_request', async () => {
    const res = await post(
      '/token',
      form({ grant_type: 'refresh_token', client_id: CLIENT_NO_REFRESH, refresh_token: 'x' }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unauthorized_client');

    const missing = await post('/token', form({ grant_type: 'refresh_token', client_id: CLIENT }));
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe('invalid_request');
  });

  it('CONCURRENT refresh of the same value => at most one 200, at most one descendant, family fully revoked', async () => {
    const rt = await firstRefresh();
    const familyDoc = await refreshModel.findOne({ tokenHash: sha256(rt) }).lean<Record<string, unknown>>();
    const familyId = familyDoc!.familyId as string;

    const [a, b] = await Promise.all([refreshReq(rt), refreshReq(rt)]);
    const codes = [a.statusCode, b.statusCode].sort();
    // At least one loses the atomic swap => 400. Strict rotation: the swap winner may ALSO fail
    // closed (400) when the concurrent reuse revoke stamped the family before it finished — either
    // [200,400] or [400,400] is correct, never two successes.
    expect(codes[0]).toBe(400);
    expect(codes).not.toContain(500);
    expect(codes.filter((c) => c === 200).length).toBeLessThanOrEqual(1);

    // at most one descendant minted (parentId === the original _id); never two.
    const descendants = await refreshModel
      .find({ familyId, parentId: familyDoc!._id })
      .lean<Record<string, unknown>[]>();
    expect(descendants.length).toBeLessThanOrEqual(1);
    // INV-11: the whole family is revoked after the race (loser counted as reuse), no survivor.
    const all = await refreshModel.find({ familyId }).lean<Record<string, unknown>[]>();
    expect(all.every((d) => d.revokedAt)).toBe(true);
  });

  it('DETERMINISTIC race (INV-11): descendant minted during reuse revoke cannot survive', async () => {
    // Force the losing order the race-close must handle: the winning rotate (A) has already done
    // its atomic swap and is blocked INSIDE insertRefreshToken; while blocked we run the losing
    // reuse request (B) to completion (it stamps + revokes the family) and only then let A finish.
    // Without the mark-then-check guard, A's successor S would be born AFTER B's revoke and live on.
    const rt = await firstRefresh();
    const familyDoc = await refreshModel.findOne({ tokenHash: sha256(rt) }).lean<Record<string, unknown>>();
    const familyId = familyDoc!.familyId as string;

    const real = tokenSvc.insertRefreshToken.bind(tokenSvc);
    let release!: () => void;
    let signalInserted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Resolves the instant A's real insert returns, so B runs AFTER S exists without a timer.
    const inserted = new Promise<void>((resolve) => {
      signalInserted = resolve;
    });
    const spy = jest
      .spyOn(tokenSvc, 'insertRefreshToken')
      .mockImplementationOnce(async (input: Parameters<TokenService['insertRefreshToken']>[0]) => {
        // A has won the swap; do the real insert so S exists, signal it, then block before returning.
        const minted = await real(input);
        signalInserted();
        await gate;
        return minted;
      });

    try {
      // A: wins the swap, mints S, then parks on the gate (not yet returned).
      const aPromise = refreshReq(rt);
      // Deterministic ordering: wait for A's insert to actually create S before running B.
      await inserted;

      // B: same value → swap misses → classifyMiss sees revoked+replacedBy → reuse revoke.
      const b = await refreshReq(rt);
      expect(b.statusCode).toBe(400);
      expect(b.json().error).toBe('invalid_grant');

      // Now let A finish. With this forced order (B's stamp lands before A's post-insert re-read),
      // A's re-read MUST observe familyRevokedAt and take the self-revoke branch → 400 invalid_grant.
      release();
      const a = await aPromise;
      expect(a.statusCode).toBe(400);
      expect(a.json().error).toBe('invalid_grant');

      // S must NOT be usable and the family must be fully dead.
      const all = await refreshModel.find({ familyId }).lean<Record<string, unknown>[]>();
      expect(all.length).toBeGreaterThanOrEqual(2); // parent + successor S
      expect(all.every((d) => d.revokedAt)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('DETERMINISTIC race (INV-11): descendant minted during /revoke cannot survive', async () => {
    // Same forced order as the reuse case, but the concurrent revoker is /revoke (not reuse). This
    // is the regression the senior flagged: /revoke's revokeFamily must also stamp familyRevokedAt
    // so A's post-insert re-read self-revokes S. Without that stamp S would be born after /revoke's
    // revoke updateMany (A parked on the gate) and survive even though /revoke returned 200.
    const rt = await firstRefresh();
    const familyDoc = await refreshModel.findOne({ tokenHash: sha256(rt) }).lean<Record<string, unknown>>();
    const familyId = familyDoc!.familyId as string;

    const real = tokenSvc.insertRefreshToken.bind(tokenSvc);
    let release!: () => void;
    let signalInserted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inserted = new Promise<void>((resolve) => {
      signalInserted = resolve;
    });
    const spy = jest
      .spyOn(tokenSvc, 'insertRefreshToken')
      .mockImplementationOnce(async (input: Parameters<TokenService['insertRefreshToken']>[0]) => {
        const minted = await real(input);
        signalInserted();
        await gate;
        return minted;
      });

    try {
      // A: wins the swap on rt, mints S, then parks on the gate (not yet returned).
      const aPromise = refreshReq(rt);
      await inserted;

      // B: /revoke the (now rotated) parent rt → revokeFamily stamps familyRevokedAt + revokes.
      const b = await post('/revoke', form({ client_id: CLIENT, token: rt }));
      expect(b.statusCode).toBe(200);

      // Let A finish: its re-read MUST see familyRevokedAt and self-revoke S → 400 invalid_grant.
      release();
      const a = await aPromise;
      expect(a.statusCode).toBe(400);
      expect(a.json().error).toBe('invalid_grant');

      // The whole family — including the just-minted successor S — is dead.
      const all = await refreshModel.find({ familyId }).lean<Record<string, unknown>[]>();
      expect(all.length).toBeGreaterThanOrEqual(2); // parent + successor S
      expect(all.every((d) => d.revokedAt)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('fail-closed: audit failure after rotate => 500, no-store, no token leaked', async () => {
    const rt = await firstRefresh();
    const spy = jest
      .spyOn(AuditService.prototype, 'record')
      .mockRejectedValueOnce(new Error('audit down') as never);
    try {
      const res = await refreshReq(rt);
      expect(res.statusCode).toBe(500);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = res.json();
      expect(body.error).toBe('server_error');
      expect(body.access_token).toBeUndefined();
      expect(body.refresh_token).toBeUndefined();
    } finally {
      spy.mockRestore();
    }

    // Consequence of strict rotation (acceptance Task 5): the atomic swap already consumed rt, so
    // retrying the SAME value fails with invalid_grant (reuse) and tears the family down. The
    // client MUST re-login — this is the intended fail-closed behaviour, not a regression.
    const familyId = (await refreshModel.findOne({ tokenHash: sha256(rt) }).lean<Record<string, unknown>>())!
      .familyId as string;
    const retry = await refreshReq(rt);
    expect(retry.statusCode).toBe(400);
    expect(retry.json().error).toBe('invalid_grant');
    const all = await refreshModel.find({ familyId }).lean<Record<string, unknown>[]>();
    expect(all.every((d) => d.revokedAt)).toBe(true);
  });

  // ----- Task 4: POST /revoke -----

  it('revoke a valid refresh => 200, doc revoked, audit TOKEN_REVOKED; reuse at /token => invalid_grant (no reuse audit)', async () => {
    const rt = await firstRefresh();
    const doc0 = await refreshModel.findOne({ tokenHash: sha256(rt) }).lean<Record<string, unknown>>();
    const familyId = doc0!.familyId as string;
    const reuseBefore = await auditModel.countDocuments({
      action: AuditAction.TOKEN_REUSE_DETECTED,
      'metadata.familyId': familyId,
    });

    const res = await post('/revoke', form({ client_id: CLIENT, token: rt }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const doc = await refreshModel.findOne({ tokenHash: sha256(rt) }).lean<Record<string, unknown>>();
    expect(doc!.revokedAt).toBeTruthy();
    const revoked = await auditModel.find({
      action: AuditAction.TOKEN_REVOKED,
      'metadata.familyId': familyId,
    }).lean();
    expect(revoked).toHaveLength(1);

    const reuseRes = await refreshReq(rt);
    expect(reuseRes.statusCode).toBe(400);
    expect(reuseRes.json().error).toBe('invalid_grant');
    const reuseAfter = await auditModel.countDocuments({
      action: AuditAction.TOKEN_REUSE_DETECTED,
      'metadata.familyId': familyId,
    });
    expect(reuseAfter).toBe(reuseBefore);
  });

  it('revoke by active child (after one rotation) revokes the whole family; so does revoke by rotated parent', async () => {
    const rt = await firstRefresh();
    const child = (await refreshReq(rt)).json().refresh_token as string;
    const doc = await refreshModel.findOne({ tokenHash: sha256(child) }).lean<Record<string, unknown>>();
    const familyId = doc!.familyId as string;

    const res = await post('/revoke', form({ client_id: CLIENT, token: child }));
    expect(res.statusCode).toBe(200);
    const all = await refreshModel.find({ familyId }).lean<Record<string, unknown>[]>();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.every((d) => d.revokedAt)).toBe(true);

    // revoking by the already-rotated parent is still a 200 (idempotent family revoke).
    const byParent = await post('/revoke', form({ client_id: CLIENT, token: rt }));
    expect(byParent.statusCode).toBe(200);
  });

  it('revoke twice => both 200, exactly one TOKEN_REVOKED audit', async () => {
    const rt = await firstRefresh();
    const familyId = (await refreshModel.findOne({ tokenHash: sha256(rt) }).lean<Record<string, unknown>>())!
      .familyId as string;
    const r1 = await post('/revoke', form({ client_id: CLIENT, token: rt }));
    const r2 = await post('/revoke', form({ client_id: CLIENT, token: rt }));
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    const audits = await auditModel.find({
      action: AuditAction.TOKEN_REVOKED,
      'metadata.familyId': familyId,
    }).lean();
    expect(audits).toHaveLength(1);
  });

  it('revoke: both Basic and body secret => invalid_request; missing token => invalid_request', async () => {
    const basic = Buffer.from(`${CLIENT}:x`).toString('base64');
    const both = await post(
      '/revoke',
      form({ client_id: CLIENT, client_secret: 'x', token: 'y' }),
      { authorization: `Basic ${basic}` },
    );
    expect(both.statusCode).toBe(400);
    expect(both.json().error).toBe('invalid_request');
    expect(both.headers['cache-control']).toBe('no-store');

    const missing = await post('/revoke', form({ client_id: CLIENT }));
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe('invalid_request');
  });

  it('revoke: audit/log never contains the token value', async () => {
    const rt = await firstRefresh();
    await post('/revoke', form({ client_id: CLIENT, token: rt }));
    const anyAudit = await auditModel.find({ action: AuditAction.TOKEN_REVOKED }).lean();
    const dump = JSON.stringify(anyAudit);
    expect(dump).not.toContain(rt);
    expect(dump).not.toContain(sha256(rt));
  });

  it('revoke token of another client (IDOR) => 200 but token A untouched', async () => {
    const rt = await firstRefresh(CLIENT);
    const res = await post('/revoke', form({ client_id: CLIENT_B, token: rt }));
    expect(res.statusCode).toBe(200);
    const doc = await refreshModel.findOne({ tokenHash: sha256(rt) }).lean<Record<string, unknown>>();
    expect(doc!.revokedAt).toBeFalsy();
    // owner can still use it.
    const ok = await refreshReq(rt);
    expect(ok.statusCode).toBe(200);
  });

  it('revoke unknown token / wrong type => 200 no-op', async () => {
    const res = await post('/revoke', form({ client_id: CLIENT, token: 'nope', token_type_hint: 'access_token' }));
    expect(res.statusCode).toBe(200);
  });

  it('revoke with bad client auth => 401 invalid_client + no-store', async () => {
    const res = await post('/revoke', form({ token: 'x' }));
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_client');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('revoke: Mongo failure => 500 server_error + no-store (fail-closed exception to always-200)', async () => {
    const rt = await firstRefresh();
    const spy = jest
      .spyOn(refreshSvc, 'revokeByToken')
      .mockRejectedValueOnce(new Error('mongo down') as never);
    try {
      const res = await post('/revoke', form({ client_id: CLIENT, token: rt }));
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('server_error');
      expect(res.headers['cache-control']).toBe('no-store');
    } finally {
      spy.mockRestore();
    }
  });

  // ----- QA additions (run 14 tester): dispatch, concurrency, enumeration edges -----

  it('QA: grant_type=password and empty grant_type both => 400 unsupported_grant_type (dispatch, no rotation)', async () => {
    // tech-lead fold (Task 3 acceptance) names `password`/empty explicitly; token.int-spec only
    // exercises `client_credentials`. The dispatch must reject these BEFORE client auth / rotation.
    const pwd = await post('/token', form({ grant_type: 'password', client_id: CLIENT, refresh_token: 'x' }));
    expect(pwd.statusCode).toBe(400);
    expect(pwd.json().error).toBe('unsupported_grant_type');
    expect(pwd.headers['cache-control']).toBe('no-store');

    const empty = await post('/token', form({ grant_type: '', client_id: CLIENT }));
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toBe('unsupported_grant_type');

    const absent = await post('/token', form({ client_id: CLIENT }));
    expect(absent.statusCode).toBe(400);
    expect(absent.json().error).toBe('unsupported_grant_type');
  });

  it('QA: invalid_scope must NOT emit a reuse audit (bad request is not a security event)', async () => {
    // Guards the exposure/false-alarm budget: a scope-escalation attempt on an ACTIVE token is a
    // plain 400, never a TOKEN_REUSE_DETECTED alert, and leaves the token usable.
    const rt = await firstRefresh();
    const familyId = (await refreshModel.findOne({ tokenHash: sha256(rt) }).lean<Record<string, unknown>>())!
      .familyId as string;
    const before = await auditModel.countDocuments({
      action: AuditAction.TOKEN_REUSE_DETECTED,
      'metadata.familyId': familyId,
    });
    const res = await refreshReq(rt, { scope: 'openid profile admin' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_scope');
    const after = await auditModel.countDocuments({
      action: AuditAction.TOKEN_REUSE_DETECTED,
      'metadata.familyId': familyId,
    });
    expect(after).toBe(before);
    // token still active → usable.
    expect((await refreshReq(rt)).statusCode).toBe(200);
  });

  it('QA: CONCURRENT /revoke of the same value => both 200, exactly one TOKEN_REVOKED audit (atomic idempotency)', async () => {
    // dev only covers sequential double-revoke. The `familyRevokedAt: null` / `revokedAt: null`
    // filters must make the audit fire once even when two /revoke land at once (INV-11 spirit).
    const rt = await firstRefresh();
    const familyId = (await refreshModel.findOne({ tokenHash: sha256(rt) }).lean<Record<string, unknown>>())!
      .familyId as string;
    const [a, b] = await Promise.all([
      post('/revoke', form({ client_id: CLIENT, token: rt })),
      post('/revoke', form({ client_id: CLIENT, token: rt })),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const all = await refreshModel.find({ familyId }).lean<Record<string, unknown>[]>();
    expect(all.every((d) => d.revokedAt)).toBe(true);
    const audits = await auditModel.find({
      action: AuditAction.TOKEN_REVOKED,
      'metadata.familyId': familyId,
    }).lean();
    expect(audits).toHaveLength(1);
  });

  it('QA: /revoke of an expired refresh => 200 (RFC 7009 idempotent, no error leak)', async () => {
    const rt = await firstRefresh();
    await refreshModel.updateOne(
      { tokenHash: sha256(rt) },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const res = await post('/revoke', form({ client_id: CLIENT, token: rt }));
    // RFC 7009: even an invalid/expired token value yields 200; no enumeration via status.
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('QA: body resource mismatch is rejected BEFORE the token is burned (invalid_target, still usable)', async () => {
    // Confirms a bad `resource` is a non-destructive 400 (INV-13 spirit) and the refresh survives.
    const rt = await firstRefresh();
    const bad = await refreshReq(rt, { resource: 'https://evil.example.com/' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid_target');
    const doc = await refreshModel.findOne({ tokenHash: sha256(rt) }).lean<Record<string, unknown>>();
    expect(doc!.revokedAt).toBeFalsy();
    expect(doc!.replacedBy).toBeFalsy();
    expect((await refreshReq(rt)).statusCode).toBe(200);
  });
});
