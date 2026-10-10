import { jest } from '@jest/globals';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { ConfigService } from '@nestjs/config';
import { SignJWT, decodeProtectedHeader } from 'jose';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditAction } from '../security/audit/audit-action.enum';
import type { AuditService } from '../security/audit/audit.service';
import { KEY_PROVIDER } from './key-provider';
import { KeyRotationService } from './key-rotation.service';
import { KeysController } from './keys.controller';
import { ClientCorsService } from '../clients/client-cors.service';
import { LocalKeyProvider } from './local-key-provider';
import { TokenSigner } from './token-signer';
import { TokenVerifier } from './token-verifier';

const ISSUER = 'http://localhost:4000';
const AUD = 'https://api.example.test/';
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi'];

const config = {
  getOrThrow: (key: string) => ({ app: { issuer: ISSUER }, token: { accessTokenTtl: 900 } })[key],
} as unknown as ConfigService;

describe('Keys (B1.9, INV-19)', () => {
  let dir: string;
  let provider: LocalKeyProvider;
  let signer: TokenSigner;
  let verifier: TokenVerifier;
  let rotation: KeyRotationService;
  let audit: { record: jest.Mock<AuditService['record']> };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vg-keys-'));
    provider = new LocalKeyProvider(dir);
    await provider.init();
    signer = new TokenSigner(provider, config);
    verifier = new TokenVerifier(provider, config);
    audit = { record: jest.fn<AuditService['record']>().mockResolvedValue({} as never) };
    rotation = new KeyRotationService(provider, audit as unknown as AuditService, config);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('GET /jwks.json returns only public RSA members (no d/p/q/dp/dq/qi)', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [KeysController],
      providers: [
        { provide: KEY_PROVIDER, useValue: provider },
        // CORS is only exercised when the browser sends an `Origin`; this request sends none, so a
        // stub that always denies is enough to satisfy the controller's DI dependency.
        {
          provide: ClientCorsService,
          useValue: { isOriginRegisteredForAnyClient: async () => false },
        },
      ],
    }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    try {
      const res = await app
        .getHttpAdapter()
        .getInstance()
        .inject({ method: 'GET', url: '/jwks.json' });
      expect(res.statusCode).toBe(200);
      const { keys } = res.json() as { keys: Record<string, string>[] };
      expect(keys).toHaveLength(1);
      expect(Object.keys(keys[0]).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
      expect(keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' });
      for (const m of PRIVATE_MEMBERS) {
        expect(res.body).not.toContain(`"${m}"`);
      }
    } finally {
      await app.close();
    }
  });

  it('state file holds no private material; PEM is PKCS8', async () => {
    const state = await readFile(join(dir, 'keys.json'), 'utf8');
    expect(state).not.toMatch(/PRIVATE KEY|"d"|"p"|"q"/);
    const pem = (await readdir(dir)).find((f) => f.endsWith('.pem'))!;
    expect(await readFile(join(dir, pem), 'utf8')).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  });

  it('signs RS256 with kid/iss/aud/exp/jti and verifies', async () => {
    const token = await signer.sign(
      { scope: 'read' },
      { audience: AUD, subject: 'usr_1', expiresInSec: 60 },
    );
    const header = decodeProtectedHeader(token);
    const [{ kid }] = await provider.getPublicKeys();
    expect(header).toMatchObject({ alg: 'RS256', kid, typ: 'JWT' });

    const payload = await verifier.verify(token, AUD);
    expect(payload).toMatchObject({ iss: ISSUER, aud: AUD, sub: 'usr_1', scope: 'read' });
    expect(typeof payload.exp).toBe('number');
    expect(typeof payload.jti).toBe('string');
  });

  it('rejects wrong audience, wrong issuer, expired, missing exp, and non-RS256 tokens', async () => {
    const good = await signer.sign({}, { audience: AUD, expiresInSec: 60 });
    await expect(verifier.verify(good, 'https://other.example/')).rejects.toThrow(/aud/);

    const otherIssuer = new TokenSigner(provider, {
      getOrThrow: () => ({ issuer: 'https://evil.example' }),
    } as unknown as ConfigService);
    await expect(
      verifier.verify(await otherIssuer.sign({}, { audience: AUD, expiresInSec: 60 }), AUD),
    ).rejects.toThrow(/iss/);

    const expired = await signer.sign({}, { audience: AUD, expiresInSec: -10 });
    await expect(verifier.verify(expired, AUD)).rejects.toThrow(/exp/);

    const { kid, privateKey } = await provider.getSigningKey();
    const noExp = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .sign(privateKey);
    await expect(verifier.verify(noExp, AUD)).rejects.toThrow(/exp/);

    const hs = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', kid })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setExpirationTime('1m')
      .sign(new TextEncoder().encode('x'.repeat(32)));
    await expect(verifier.verify(hs, AUD)).rejects.toThrow();
  });

  describe('verifyAccessToken (RFC 9068, token confusion)', () => {
    /** Mint an access-token-shaped JWT, then override the protected header / payload / signing key. */
    async function mint(
      over: {
        header?: Record<string, unknown>;
        claims?: Record<string, unknown>;
        issuer?: string;
        audience?: string | string[];
        omitExp?: boolean;
        key?: Uint8Array;
      } = {},
    ): Promise<string> {
      const { kid, privateKey } = await provider.getSigningKey();
      const jwt = new SignJWT({
        sub: 'usr_1',
        jti: 'jti_1',
        client_id: 'app_1',
        scope: 'openid',
        ...over.claims,
      })
        .setProtectedHeader({ alg: 'RS256', kid, typ: 'at+jwt', ...over.header })
        .setIssuer(over.issuer ?? ISSUER)
        .setAudience(over.audience ?? AUD)
        .setIssuedAt();
      if (!over.omitExp) jwt.setExpirationTime('1m');
      return jwt.sign(over.key ?? privateKey);
    }

    it('accepts a genuine access token (typ at+jwt, all required claims, single aud)', async () => {
      const claims = await verifier.verifyAccessToken(await mint());
      expect(claims).toMatchObject({
        iss: ISSUER,
        aud: AUD,
        sub: 'usr_1',
        jti: 'jti_1',
        client_id: 'app_1',
        scope: 'openid',
      });
    });

    it('rejects a non-RS256 alg (HS256)', async () => {
      const { kid } = await provider.getSigningKey();
      const hs = await mint({
        header: { alg: 'HS256', kid },
        key: new TextEncoder().encode('x'.repeat(32)),
      });
      await expect(verifier.verifyAccessToken(hs)).rejects.toThrow();
    });

    it('rejects a wrong issuer', async () => {
      await expect(
        verifier.verifyAccessToken(await mint({ issuer: 'https://evil.example' })),
      ).rejects.toThrow();
    });

    it('rejects a token missing exp', async () => {
      await expect(verifier.verifyAccessToken(await mint({ omitExp: true }))).rejects.toThrow();
    });

    it.each(['sub', 'jti', 'client_id', 'scope'])(
      'rejects a token missing the required claim %s',
      async (claim) => {
        const claims: Record<string, unknown> = {
          sub: 'usr_1',
          jti: 'jti_1',
          client_id: 'app_1',
          scope: 'openid',
        };
        delete claims[claim];
        // Replace the whole payload so the dropped claim is actually absent (spread cannot remove it).
        const { kid, privateKey } = await provider.getSigningKey();
        const token = await new SignJWT(claims)
          .setProtectedHeader({ alg: 'RS256', kid, typ: 'at+jwt' })
          .setIssuer(ISSUER)
          .setAudience(AUD)
          .setIssuedAt()
          .setExpirationTime('1m')
          .sign(privateKey);
        await expect(verifier.verifyAccessToken(token)).rejects.toThrow();
      },
    );

    it('rejects a multi-valued aud (array)', async () => {
      await expect(
        verifier.verifyAccessToken(await mint({ audience: [AUD, 'https://b.example/'] })),
      ).rejects.toThrow(/aud/);
    });

    it('rejects an ID token (typ JWT) presented as an access token (token confusion)', async () => {
      // Same signer, same required claims, but `typ: JWT` — the defining difference an RP/RS relies
      // on. Must fail so an ID token can never be replayed at `/userinfo` or `/introspect`.
      const idToken = await mint({ header: { typ: 'JWT' } });
      await expect(verifier.verifyAccessToken(idToken)).rejects.toThrow();
    });

    it.each(['sub', 'client_id', 'scope', 'jti'])(
      'rejects a non-string %s (would otherwise 500, not 401)',
      async (claim) => {
        await expect(
          verifier.verifyAccessToken(await mint({ claims: { [claim]: 123 } })),
        ).rejects.toThrow();
      },
    );
  });

  it('normal rotation: old token still verifies, JWKS keeps old key, new tokens use new kid; audited', async () => {
    const [{ kid: oldKid }] = await provider.getPublicKeys();
    const oldToken = await signer.sign({}, { audience: AUD, expiresInSec: 60 });

    const result = await rotation.rotate('normal', 'admin_1');
    expect(result).toMatchObject({ oldKid, mode: 'normal' });

    const kids = (await provider.getPublicKeys()).map((k) => k.kid);
    expect(kids).toEqual(expect.arrayContaining([oldKid, result.newKid]));
    await expect(verifier.verify(oldToken, AUD)).resolves.toBeDefined();

    const newToken = await signer.sign({}, { audience: AUD, expiresInSec: 60 });
    expect(decodeProtectedHeader(newToken).kid).toBe(result.newKid);
    expect(await readdir(dir)).not.toContain(`${oldKid}.pem`); // verify-only: private key gone

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.SIGNING_KEY_ROTATED,
        actorId: 'admin_1',
        targetId: result.newKid,
        metadata: { mode: 'normal', oldKid },
      }),
    );
  });

  it('normal rotation: old key leaves JWKS after the retention window', async () => {
    const [{ kid: oldKid }] = await provider.getPublicKeys();
    await provider.rotate('normal', 0);
    await new Promise((r) => setTimeout(r, 5));
    expect((await provider.getPublicKeys()).map((k) => k.kid)).not.toContain(oldKid);
  });

  it('emergency rotation: old token fails immediately, JWKS drops old key', async () => {
    const [{ kid: oldKid }] = await provider.getPublicKeys();
    const oldToken = await signer.sign({}, { audience: AUD, expiresInSec: 60 });

    const result = await rotation.rotate('emergency', 'admin_1');

    const kids = (await provider.getPublicKeys()).map((k) => k.kid);
    expect(kids).toEqual([result.newKid]);
    expect(kids).not.toContain(oldKid);
    await expect(verifier.verify(oldToken, AUD)).rejects.toThrow();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { mode: 'emergency', oldKid } }),
    );
  });
});
