import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { ConfigService } from '@nestjs/config';
import { SignJWT, decodeProtectedHeader } from 'jose';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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

/** Deferred promise helper for the deterministic race tests (DEBT-145). */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * Holds the N-th `atomicRename` (0-based) until released: a rotate is paused AFTER it read state and
 * wrote its temp file, but BEFORE `keys.json` is replaced — the exact window DEBT-145 is about.
 */
class GatedKeyProvider extends LocalKeyProvider {
  readonly gates = new Map<
    number,
    { reached: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }
  >();
  renames = 0;

  gate(n: number): { reached: Promise<void>; release: () => void } {
    const g = { reached: deferred(), release: deferred() };
    this.gates.set(n, g);
    return { reached: g.reached.promise, release: g.release.resolve };
  }

  protected override async atomicRename(tmpPath: string, finalPath: string): Promise<void> {
    const g = this.gates.get(this.renames++);
    if (g) {
      g.reached.resolve();
      await g.release.promise;
    }
    return super.atomicRename(tmpPath, finalPath);
  }
}

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

  describe('verifyIdTokenHint (B4.7 RP-initiated logout)', () => {
    /** Mint an ID-token-shaped JWT (typ JWT, aud=clientId). */
    async function mintId(
      over: {
        header?: Record<string, unknown>;
        claims?: Record<string, unknown>;
        issuer?: string;
        audience?: string | string[];
        expiresInSec?: number;
        subject?: string;
        key?: Uint8Array;
      } = {},
    ): Promise<string> {
      const { kid, privateKey } = await provider.getSigningKey();
      const exp = Math.floor(Date.now() / 1000) + (over.expiresInSec ?? 60);
      const jwt = new SignJWT({ ...over.claims })
        .setProtectedHeader({ alg: 'RS256', kid, ...over.header })
        .setIssuer(over.issuer ?? ISSUER)
        .setAudience(over.audience ?? 'app_1')
        .setSubject(over.subject ?? 'usr_1')
        .setIssuedAt()
        .setExpirationTime(exp);
      return jwt.sign(over.key ?? privateKey);
    }

    it('accepts a valid ID token and returns { sub, aud }', async () => {
      const result = await verifier.verifyIdTokenHint(await mintId());
      expect(result).toEqual({ sub: 'usr_1', aud: 'app_1' });
    });

    it('accepts an EXPIRED ID token (logout after the session died)', async () => {
      const result = await verifier.verifyIdTokenHint(await mintId({ expiresInSec: -3600 }));
      expect(result).toEqual({ sub: 'usr_1', aud: 'app_1' });
    });

    it('accepts a single-element aud array', async () => {
      const result = await verifier.verifyIdTokenHint(await mintId({ audience: ['app_1'] }));
      expect(result.aud).toBe('app_1');
    });

    it('rejects a wrong issuer', async () => {
      await expect(
        verifier.verifyIdTokenHint(await mintId({ issuer: 'https://evil.example' })),
      ).rejects.toThrow();
    });

    it('rejects an access token (typ at+jwt) presented as a hint (token confusion)', async () => {
      await expect(
        verifier.verifyIdTokenHint(await mintId({ header: { typ: 'at+jwt' } })),
      ).rejects.toThrow(/access token/);
    });

    it('rejects a multi-valued aud', async () => {
      await expect(
        verifier.verifyIdTokenHint(await mintId({ audience: ['app_1', 'app_2'] })),
      ).rejects.toThrow(/aud/);
    });

    it('rejects a non-RS256 alg (HS256)', async () => {
      const { kid } = await provider.getSigningKey();
      const hs = await mintId({
        header: { alg: 'HS256', kid },
        key: new TextEncoder().encode('x'.repeat(32)),
      });
      await expect(verifier.verifyIdTokenHint(hs)).rejects.toThrow();
    });
  });

  it('normal rotation: old token still verifies, JWKS keeps old key, new tokens use new kid; audited', async () => {
    const [{ kid: oldKid }] = await provider.getPublicKeys();
    const oldToken = await signer.sign({}, { audience: AUD, expiresInSec: 60 });

    const result = await rotation.rotate('normal', { actorType: 'admin', actorId: 'admin_1' });
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

    const result = await rotation.rotate('emergency', { actorType: 'admin', actorId: 'admin_1' });

    const kids = (await provider.getPublicKeys()).map((k) => k.kid);
    expect(kids).toEqual([result.newKid]);
    expect(kids).not.toContain(oldKid);
    await expect(verifier.verify(oldToken, AUD)).rejects.toThrow();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { mode: 'emergency', oldKid } }),
    );
  });

  describe('KeyRotationService failure semantics (B6.3c)', () => {
    const base = {
      actorType: 'admin' as const,
      actorId: 'admin_1',
      tenantId: 't1',
      requestId: 'r1',
    };

    it('state write fails => rejects, old key still active, failure audit with reason (best-effort)', async () => {
      const { kid: oldKid } = await provider.getSigningKey();
      jest
        .spyOn(provider as unknown as { atomicRename: () => Promise<void> }, 'atomicRename')
        .mockRejectedValueOnce(new Error('ENOSPC'));
      audit.record.mockRejectedValueOnce(new Error('mongo down')); // failure audit is best-effort

      await expect(rotation.rotate('normal', base)).rejects.toThrow('ENOSPC');
      expect((await provider.getSigningKey()).kid).toBe(oldKid);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          ...base,
          action: AuditAction.SIGNING_KEY_ROTATED,
          result: 'failure',
          reason: 'rotate_failed',
          metadata: { mode: 'normal' },
        }),
      );
    });

    it('audit fails after a successful rotate => rejects, rotation NOT rolled back, only kid logged', async () => {
      const { kid: oldKid } = await provider.getSigningKey();
      audit.record.mockRejectedValueOnce(new Error('mongo down'));
      const err = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      err.mockClear();

      await expect(rotation.rotate('emergency', base)).rejects.toThrow('mongo down');
      const kids = (await provider.getPublicKeys()).map((k) => k.kid);
      expect(kids).not.toContain(oldKid);
      expect(kids).toHaveLength(1);
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0][0])).toContain(kids[0]);
      expect(String(err.mock.calls[0][0])).not.toMatch(/PRIVATE|\.pem|[\\/]/);
    });

    it('success audit carries the admin base + {mode, oldKid}', async () => {
      const { kid: oldKid } = await provider.getSigningKey();
      const r = await rotation.rotate('normal', base);
      expect(audit.record).toHaveBeenCalledWith({
        ...base,
        action: AuditAction.SIGNING_KEY_ROTATED,
        targetType: 'signing_key',
        targetId: r.newKid,
        result: 'success',
        metadata: { mode: 'normal', oldKid },
      });
    });
  });

  describe('DEBT-007: rotate() keeps a usable active key when persisting state fails', () => {
    it('normal: writeState throws => rotate rejects, old kid still signs, JWKS keeps old key', async () => {
      const { kid: oldKid } = await provider.getSigningKey();
      jest
        .spyOn(provider as unknown as { writeState: () => Promise<void> }, 'writeState')
        .mockRejectedValueOnce(new Error('ENOSPC'));

      await expect(provider.rotate('normal', 60)).rejects.toThrow();

      // The old key is still active and can sign (not deleted before the state was durable).
      const after = await provider.getSigningKey();
      expect(after.kid).toBe(oldKid);
      await expect(signer.sign({}, { audience: AUD, expiresInSec: 60 })).resolves.toBeDefined();
      expect((await provider.getPublicKeys()).map((k) => k.kid)).toContain(oldKid);
    });

    it('emergency: writeState throws => rotate rejects, old kid still signs', async () => {
      const { kid: oldKid } = await provider.getSigningKey();
      jest
        .spyOn(provider as unknown as { writeState: () => Promise<void> }, 'writeState')
        .mockRejectedValueOnce(new Error('EPERM'));

      await expect(provider.rotate('emergency', 60)).rejects.toThrow();

      const after = await provider.getSigningKey();
      expect(after.kid).toBe(oldKid);
      await expect(signer.sign({}, { audience: AUD, expiresInSec: 60 })).resolves.toBeDefined();
    });

    it('removing the old PEM fails internally => rotate still resolves (durable state), new kid signs, warn logged', async () => {
      const { kid: oldKid } = await provider.getSigningKey();
      // Delete the old PEM up front so the provider's internal `rm` runs on a missing file. With
      // `force:true` that does NOT throw, so to simulate a real rm failure (EBUSY/EPERM) we make
      // `pemPath` return a path that cannot be removed: a directory with a child. The rm failure
      // must be swallowed (warn) and the rotation must still succeed.
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const badDir = join(dir, `${oldKid}.pem`);
      await rm(badDir, { force: true });
      await mkdir(badDir);
      await writeFile(join(badDir, 'keep'), 'x');

      const result = await provider.rotate('normal', 60);
      expect(result.oldKid).toBe(oldKid);

      const after = await provider.getSigningKey();
      expect(after.kid).toBe(result.newKid);
      expect(
        decodeProtectedHeader(await signer.sign({}, { audience: AUD, expiresInSec: 60 })).kid,
      ).toBe(result.newKid);
      expect(warn).toHaveBeenCalled();
    });

    it('atomic replace: rename failure leaves the old keys.json intact and parseable, no *.tmp left', async () => {
      // Write a known-good state so we can prove it survives a failed write (M15: a direct overwrite
      // of keys.json would corrupt/replace it; the tmp+rename path must leave it byte-intact).
      const stateFile = join(dir, 'keys.json');
      const before = await readFile(stateFile, 'utf8');
      JSON.parse(before); // sanity: current state is valid JSON

      const renameSpy = jest
        .spyOn(provider as unknown as { atomicRename: () => Promise<void> }, 'atomicRename')
        .mockRejectedValueOnce(new Error('EXDEV cross-device'));

      await expect(provider.rotate('normal', 60)).rejects.toThrow();
      renameSpy.mockRestore();

      // Old state intact + still valid JSON, and the temp file was cleaned up.
      expect(await readFile(stateFile, 'utf8')).toBe(before);
      JSON.parse(await readFile(stateFile, 'utf8'));
      expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    });

    it('emergency: a failed rm of the (compromised) old PEM logs at ERROR, not WARN (M16)', async () => {
      const { kid: oldKid } = await provider.getSigningKey();
      // Same trick as the normal-rotation rm test: a directory-with-child cannot be rm'd.
      // Clear so earlier tests' (non-restored) prototype spies do not pollute the call counts.
      const err = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      err.mockClear();
      warn.mockClear();
      const badDir = join(dir, `${oldKid}.pem`);
      await rm(badDir, { force: true });
      await mkdir(badDir);
      await writeFile(join(badDir, 'keep'), 'x');

      await provider.rotate('emergency', 60);
      // A compromised key that cannot be deleted MUST be visible at error level.
      expect(err).toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it('does NOT touch an unrelated .pem (no orphan GC — shared key dir, DEBT-007 fold)', async () => {
      const strayKid = '00000000-0000-4000-8000-000000000000';
      await writeFile(join(dir, `${strayKid}.pem`), 'stray', { mode: 0o600 });

      await provider.rotate('normal', 60);

      expect(await readdir(dir)).toContain(`${strayKid}.pem`);
    });
  });

  describe('DEBT-145: rotate is serialised; read paths never write', () => {
    let gated: GatedKeyProvider;
    let gatedSigner: TokenSigner;
    let gatedVerifier: TokenVerifier;

    beforeEach(async () => {
      gated = new GatedKeyProvider(dir); // same dir: reuses the key created by `provider.init()`
      gatedSigner = new TokenSigner(gated, config);
      gatedVerifier = new TokenVerifier(gated, config);
    });

    it('normal ∥ emergency: old kid is gone from JWKS and disk (same as sequential)', async () => {
      const { kid: oldKid } = await gated.getSigningKey();
      const g0 = gated.gate(0);
      const p1 = gated.rotate('normal', 60);
      await g0.reached; // normal read [A] and is about to replace keys.json
      const p2 = gated.rotate('emergency', 60);
      g0.release();
      const [, r2] = await Promise.all([p1, p2]);

      expect((await gated.getPublicKeys()).map((k) => k.kid)).toEqual([r2.newKid]);
      const files = await readdir(dir);
      expect(files).not.toContain(`${oldKid}.pem`);
      expect(files.filter((f) => f.endsWith('.pem'))).toEqual([`${r2.newKid}.pem`]);
      expect((await gated.getSigningKey()).kid).toBe(r2.newKid);
    });

    it('normal ∥ normal: no signed key is lost (A retiring, F1 retiring, F2 active)', async () => {
      const { kid: a } = await gated.getSigningKey();
      const g0 = gated.gate(0);
      const g1 = gated.gate(1);
      const p1 = gated.rotate('normal', 60);
      await g0.reached;
      const p2 = gated.rotate('normal', 60);
      g0.release();
      const r1 = await p1;
      await g1.reached; // second rotate is about to write; F1 is the active key right now
      const tokenF1 = await gatedSigner.sign({}, { audience: AUD, expiresInSec: 60 });
      expect(decodeProtectedHeader(tokenF1).kid).toBe(r1.newKid);
      g1.release();
      const r2 = await p2;

      expect(r2.oldKid).toBe(r1.newKid);
      const meta = await gated.listKeys();
      expect(meta.map((k) => [k.kid, k.status])).toEqual([
        [a, 'retiring'],
        [r1.newKid, 'retiring'],
        [r2.newKid, 'active'],
      ]);
      await expect(gatedVerifier.verify(tokenF1, AUD)).resolves.toBeDefined();
    });

    it('a failed rotate does not jam the chain', async () => {
      jest
        .spyOn(gated as unknown as { atomicRename: () => Promise<void> }, 'atomicRename')
        .mockRejectedValueOnce(new Error('EIO'));
      const p1 = gated.rotate('normal', 60);
      const p2 = gated.rotate('normal', 60);
      await expect(p1).rejects.toThrow('EIO');
      const r2 = await p2;
      expect((await gated.getSigningKey()).kid).toBe(r2.newKid);
    });

    it('getPublicKeys/listKeys drop an expired retiring key without writing; rotate prunes it', async () => {
      const stateFile = join(dir, 'keys.json');
      const { kid: expiredKid } = await gated.getSigningKey();
      await gated.rotate('normal', 60);
      // Age the retiring key past its window directly in the state file.
      const state = JSON.parse(await readFile(stateFile, 'utf8')) as {
        kid: string;
        retireAt?: string;
      }[];
      state.find((e) => e.kid === expiredKid)!.retireAt = new Date(Date.now() - 1000).toISOString();
      await writeFile(stateFile, JSON.stringify(state));
      const before = await readFile(stateFile, 'utf8');

      const renameSpy = jest.spyOn(
        gated as unknown as { atomicRename: () => Promise<void> },
        'atomicRename',
      );
      expect((await gated.getPublicKeys()).map((k) => k.kid)).not.toContain(expiredKid);
      expect((await gated.listKeys()).map((k) => k.kid)).not.toContain(expiredKid);
      await gated.getSigningKey();
      expect(renameSpy).not.toHaveBeenCalled();
      expect(await readFile(stateFile, 'utf8')).toBe(before);

      await gated.rotate('normal', 60);
      expect(await readFile(stateFile, 'utf8')).not.toContain(expiredKid);
    });

    it('listKeys returns metadata only (exact key set, no key material)', async () => {
      const r = await gated.rotate('normal', 900);
      const items = await gated.listKeys();
      for (const item of items) {
        expect(Object.keys(item).sort()).toEqual(['alg', 'createdAt', 'kid', 'retireAt', 'status']);
      }
      const old = items.find((k) => k.kid === r.oldKid)!;
      expect(old.status).toBe('retiring');
      expect(Math.abs(Date.parse(old.retireAt!) - (Date.now() + 900_000))).toBeLessThan(5000);
      expect(items.find((k) => k.kid === r.newKid)).toMatchObject({
        status: 'active',
        retireAt: null,
      });
    });

    it('getSigningKey re-reads state once when the active PEM vanished (ENOENT)', async () => {
      const { kid: oldKid } = await gated.getSigningKey();
      const stateFile = join(dir, 'keys.json');
      const stale = await readFile(stateFile, 'utf8');
      const r = await gated.rotate('normal', 60);
      const fresh = await readFile(stateFile, 'utf8');
      // First read sees the pre-rotate state (old PEM already deleted), second sees the new state.
      let reads = 0;
      jest
        .spyOn(gated as unknown as { readState: () => Promise<unknown> }, 'readState')
        .mockImplementation(async () => JSON.parse(reads++ === 0 ? stale : fresh));
      const key = await gated.getSigningKey();
      expect(key.kid).toBe(r.newKid);
      expect(key.kid).not.toBe(oldKid);
      expect(reads).toBe(2);
    });
  });

  describe('DEBT-163: init warns (kid only) about PEMs missing from keys.json, never deletes', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('orphan.pem + valid state => exactly one WARN naming the kid, file kept; tmp files ignored', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      await writeFile(join(dir, 'orphan.pem'), 'not-a-real-key');
      await writeFile(join(dir, 'keys.json.leftover.tmp'), '[]');
      await new LocalKeyProvider(dir).init();
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = String(warn.mock.calls[0][0]);
      expect(msg).toContain('orphan');
      expect(msg).not.toContain(dir);
      expect(msg).not.toContain('not-a-real-key');
      expect(msg).not.toContain('leftover');
      const { kid } = await provider.getSigningKey();
      expect(msg).not.toContain(kid);
      expect(await readdir(dir)).toContain('orphan.pem');
    });

    it('no orphan (fresh dir, and after rotations) => no WARN', async () => {
      await provider.rotate('normal', 60);
      await provider.rotate('emergency', 60);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      await new LocalKeyProvider(dir).init();
      const fresh = await mkdtemp(join(tmpdir(), 'vg-keys-fresh-'));
      try {
        await new LocalKeyProvider(fresh).init();
      } finally {
        await rm(fresh, { recursive: true, force: true });
      }
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
