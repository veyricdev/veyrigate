import { jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../../../common/crypto/crypto.util';
import { LocalKeyProvider } from '../../keys/local-key-provider';
import { TokenSigner } from '../../keys/token-signer';
import { TokenVerifier } from '../../keys/token-verifier';
import type { AuditService } from '../../security/audit/audit.service';
import { AuditAction } from '../../security/audit/audit-action.enum';
import type { Client } from '../../clients/client.service';
import type { AuthorizationCodeData } from '../code/authorization-code.service';
import { adminResourceIdentifier, TokenService } from './token.service';
import { TokenError } from './token.errors';

const ISSUER = 'http://localhost:4000';
const ACCESS_TTL = 900;
const REFRESH_TTL = 2592000;
const RESOURCE = 'https://api.example.com/';
const ADMIN_RESOURCE = adminResourceIdentifier(ISSUER);

const config = {
  getOrThrow: (ns: string) => {
    if (ns === 'app') return { issuer: ISSUER };
    if (ns === 'token') return { accessTokenTtl: ACCESS_TTL, refreshTokenTtl: REFRESH_TTL };
    throw new Error(`unexpected ns ${ns}`);
  },
} as unknown as ConfigService;

function client(overrides: Partial<Client> = {}): Client {
  return {
    clientId: 'rp-client',
    clientType: 'public',
    tokenEndpointAuthMethod: 'none',
    grantTypes: ['authorization_code'],
    redirectUris: [],
    postLogoutRedirectUris: [],
    allowedCorsOrigins: [],
    allowedResources: [],
    scopes: [],
    tenantId: 'tenant-A',
    ...overrides,
  };
}

const USER_ID = new Types.ObjectId().toHexString();

function codeData(overrides: Partial<AuthorizationCodeData> = {}): AuthorizationCodeData {
  return {
    clientId: 'rp-client',
    redirectUri: 'https://app.example.com/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    resource: RESOURCE,
    scope: 'openid profile',
    nonce: 'rp-nonce',
    userId: USER_ID,
    authTime: 1_700_000_000_000,
    ...overrides,
  };
}

describe('TokenService (B4.4 Task 2/3: claims + refresh minting)', () => {
  let dir: string;
  let signer: TokenSigner;
  let verifier: TokenVerifier;

  // Mongoose RefreshToken model double: records the created doc.
  let created: Record<string, unknown>[];
  let refreshModel: { create: jest.Mock<(doc: Record<string, unknown>) => Promise<unknown>> };
  let audit: { record: jest.Mock<AuditService['record']> };

  const buildService = () =>
    new TokenService(refreshModel as never, signer, audit as unknown as AuditService, config);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vg-token-'));
    const provider = new LocalKeyProvider(dir);
    await provider.init();
    signer = new TokenSigner(provider, config);
    verifier = new TokenVerifier(provider, config);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    created = [];
    refreshModel = {
      create: jest.fn<(doc: Record<string, unknown>) => Promise<unknown>>((doc) => {
        created.push(doc);
        return Promise.resolve(doc);
      }),
    };
    audit = { record: jest.fn<AuditService['record']>().mockResolvedValue({} as never) };
  });

  it('access token: iss/aud/sub/scope/client_id/jti present, exp-iat === 900', async () => {
    const res = await buildService().issueForAuthorizationCode(client(), codeData());
    const payload = await verifier.verify(res.access_token, RESOURCE);
    expect(payload.iss).toBe(ISSUER);
    expect(payload.aud).toBe(RESOURCE);
    expect(payload.sub).toBe(USER_ID);
    expect(payload.scope).toBe('openid profile');
    expect(payload.client_id).toBe('rp-client');
    expect(payload.jti).toBeDefined();
    expect((payload.exp as number) - (payload.iat as number)).toBe(ACCESS_TTL);
    expect(res.expires_in).toBe(ACCESS_TTL);
  });

  it('id token: aud=client_id, nonce byte-for-byte, auth_time floor(ms/1000), amr/acr defaults', async () => {
    const res = await buildService().issueForAuthorizationCode(client(), codeData());
    expect(res.id_token).toBeDefined();
    const payload = await verifier.verify(res.id_token!, 'rp-client');
    expect(payload.aud).toBe('rp-client');
    expect(payload.sub).toBe(USER_ID);
    expect(payload.nonce).toBe('rp-nonce');
    expect(payload.auth_time).toBe(1_700_000_000);
    expect(payload.amr).toEqual(['pwd']);
    expect(payload.acr).toBe('urn:idp:aal1');
  });

  it('auth_time in access token only when resource is the admin identifier (D3)', async () => {
    const admin = await buildService().issueForAuthorizationCode(
      client(),
      codeData({ resource: ADMIN_RESOURCE }),
    );
    const adminAt = await verifier.verify(admin.access_token, ADMIN_RESOURCE);
    expect(adminAt.auth_time).toBe(1_700_000_000);

    const normal = await buildService().issueForAuthorizationCode(client(), codeData());
    const normalAt = await verifier.verify(normal.access_token, RESOURCE);
    expect(normalAt).not.toHaveProperty('auth_time');
  });

  it('no nonce in code => id token has no nonce claim (not null/empty)', async () => {
    const res = await buildService().issueForAuthorizationCode(
      client(),
      codeData({ nonce: undefined }),
    );
    const payload = await verifier.verify(res.id_token!, 'rp-client');
    expect(payload).not.toHaveProperty('nonce');
  });

  it('id token only when scope has openid', async () => {
    const res = await buildService().issueForAuthorizationCode(
      client(),
      codeData({ scope: 'profile email' }),
    );
    expect(res.id_token).toBeUndefined();
  });

  it('authTime absent => no auth_time claim fabricated (fail-closed for step-up)', async () => {
    const res = await buildService().issueForAuthorizationCode(
      client(),
      codeData({ resource: ADMIN_RESOURCE, authTime: undefined }),
    );
    const access = await verifier.verify(res.access_token, ADMIN_RESOURCE);
    expect(access).not.toHaveProperty('auth_time');
    const id = await verifier.verify(res.id_token!, 'rp-client');
    expect(id).not.toHaveProperty('auth_time');
  });

  it('missing resource => invalid_target, no token signed, no refresh inserted', async () => {
    await expect(
      buildService().issueForAuthorizationCode(client(), codeData({ resource: undefined })),
    ).rejects.toMatchObject({ code: 'invalid_target' });
    await expect(
      buildService().issueForAuthorizationCode(client(), codeData({ resource: '' })),
    ).rejects.toBeInstanceOf(TokenError);
    expect(refreshModel.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('D7: refresh minted (hash only) when grant refresh_token AND scope offline_access', async () => {
    const res = await buildService().issueForAuthorizationCode(
      client({ grantTypes: ['authorization_code', 'refresh_token'] }),
      codeData({ scope: 'openid offline_access' }),
    );
    expect(res.refresh_token).toBeDefined();
    expect(created).toHaveLength(1);
    const doc = created[0];
    expect(doc.tokenHash).toBe(sha256(res.refresh_token!));
    expect(doc.familyId).toBeTruthy();
    expect(doc.parentId).toBeNull();
    expect(doc.scope as string[]).toEqual(['openid', 'offline_access']);
    expect(doc.resource).toBe(RESOURCE);
    const span = (doc.expiresAt as Date).getTime() - (doc.issuedAt as Date).getTime();
    expect(Math.round(span / 1000)).toBe(REFRESH_TTL);
    // plaintext never stored in any field.
    for (const v of Object.values(doc)) {
      expect(String(v)).not.toBe(res.refresh_token);
    }
  });

  it('D7 fail-closed: no refresh grant => no refresh_token, no DB doc', async () => {
    const res = await buildService().issueForAuthorizationCode(
      client({ grantTypes: ['authorization_code'] }),
      codeData({ scope: 'openid offline_access' }),
    );
    expect(res.refresh_token).toBeUndefined();
    expect(refreshModel.create).not.toHaveBeenCalled();
  });

  it('D7 fail-closed: no offline_access scope => no refresh_token, no DB doc', async () => {
    const res = await buildService().issueForAuthorizationCode(
      client({ grantTypes: ['authorization_code', 'refresh_token'] }),
      codeData({ scope: 'openid profile' }),
    );
    expect(res.refresh_token).toBeUndefined();
    expect(refreshModel.create).not.toHaveBeenCalled();
  });

  it('audit TOKEN_ISSUED recorded with no secret/token in metadata (INV-25)', async () => {
    const res = await buildService().issueForAuthorizationCode(
      client({ grantTypes: ['authorization_code', 'refresh_token'] }),
      codeData({ scope: 'openid offline_access' }),
    );
    expect(audit.record).toHaveBeenCalledTimes(1);
    const event = audit.record.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(event.action).toBe(AuditAction.TOKEN_ISSUED);
    expect(event.actorType).toBe('user');
    expect(event.actorId).toBe(USER_ID);
    expect(event.clientId).toBe('rp-client');
    const meta = event.metadata as Record<string, unknown>;
    expect(meta).toEqual({ resource: RESOURCE, scope: 'openid offline_access', refresh: true });
    const flat = JSON.stringify(event);
    expect(flat).not.toContain(res.access_token);
    expect(flat).not.toContain(res.refresh_token);
    expect(flat).not.toContain(res.id_token);
  });

  it('audit failure => error propagates, no token returned (fail-closed)', async () => {
    audit.record.mockRejectedValueOnce(new Error('mongo down'));
    await expect(buildService().issueForAuthorizationCode(client(), codeData())).rejects.toThrow(
      'mongo down',
    );
  });

  it('adminResourceIdentifier derives /admin/ from issuer', () => {
    expect(adminResourceIdentifier('http://localhost:4000')).toBe('http://localhost:4000/admin/');
  });
});
