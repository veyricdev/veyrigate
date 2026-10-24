import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JWK,
} from 'jose';
import { constants, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VaultConfig } from '../src/config/configuration';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { TokenSigner } from '../src/modules/keys/token-signer';
import { TokenVerifier } from '../src/modules/keys/token-verifier';
import {
  KEY_CACHE_TTL_MS,
  VaultTransitKeyProvider,
} from '../src/modules/keys/vault-transit-key-provider';
import { SessionService } from '../src/modules/sessions/session.service';
import {
  authorizeCode,
  bootFullApp,
  FLOW_API_AUD,
  FLOW_REDIRECT,
  formPost,
  seedFlowClient,
} from './full-app';
import { seedConsent, seedOAuthUser } from './oauth-fixtures';

/**
 * Vault Transit KeyProvider against a REAL Vault (run 53, V1–V9, V14). Opt-in via `test:vault`
 * (preflight fails — never skips — without Vault). The root token is used ONLY for setup (mount,
 * keys, policy, child tokens); every provider runs with a child token holding exactly the policy
 * `ops/vault/idp-signer.hcl`, written to a temp token file like a Vault Agent sink.
 */

const ADDR = process.env.VAULT_TEST_ADDR!;
const ROOT = process.env.VAULT_TEST_ROOT_TOKEN!;
const MOUNT = `vg-transit-${randomBytes(4).toString('hex')}`;
const ISSUER = 'http://localhost:4000';
const AUD = 'https://api.example.test/';
const TTL = 900;

interface VaultRes {
  status: number;
  body: Record<string, unknown> & { data?: Record<string, unknown> };
}

async function vault(
  method: string,
  path: string,
  body?: unknown,
  token: string = ROOT,
): Promise<VaultRes> {
  const res = await fetch(`${ADDR}/v1/${path}`, {
    method,
    headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

const config = {
  getOrThrow: (key: string) => ({ app: { issuer: ISSUER }, token: { accessTokenTtl: TTL } })[key],
} as unknown as ConfigService;

/** Counts Vault requests by op (`read`, `sign`, …) through the real fetch. */
function countingFetch(): { fetchFn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchFn: typeof fetch = (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push(
      init?.method === 'GET'
        ? 'read'
        : path.includes('/sign/')
          ? 'sign'
          : (path.split('/').pop() as string),
    );
    return fetch(url, init);
  };
  return { fetchFn, calls };
}

describe('VaultTransitKeyProvider against Vault (run 53)', () => {
  let dir: string;
  let policyTemplate: string;
  const policies: string[] = [];
  let logs: string[];

  beforeAll(async () => {
    expect((await vault('POST', `sys/mounts/${MOUNT}`, { type: 'transit' })).status).toBe(204);
    policyTemplate = await readFile(
      join(process.cwd(), '..', 'ops', 'vault', 'idp-signer.hcl'),
      'utf8',
    );
    dir = await mkdtemp(join(tmpdir(), 'vg-vault-int-'));
  });

  afterAll(async () => {
    for (const p of policies) await vault('DELETE', `sys/policies/acl/${p}`);
    await vault('DELETE', `sys/mounts/${MOUNT}`); // removes every test key
    await rm(dir, { recursive: true, force: true });
  });

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
    for (const line of logs) {
      expect(line).not.toMatch(/hvs\.|s\.[A-Za-z0-9]{20}/);
      expect(line).not.toContain(dir);
      expect(line).not.toContain(ROOT);
    }
  });

  /** New key `k-<uuid>` (+ policy from the repo template + child token in a token file). */
  async function newKey(
    create: Record<string, unknown> = {},
  ): Promise<{ key: string; token: string; tokenFile: string; policy: string }> {
    const key = `k-${randomUUID()}`;
    const created = await vault('POST', `${MOUNT}/keys/${key}`, {
      type: 'rsa-2048',
      exportable: false,
      ...create,
    });
    expect(created.status).toBeLessThan(300);
    const policy = `p-${key}`;
    const hcl = policyTemplate.replaceAll('<mount>', MOUNT).replaceAll('<key>', key);
    expect((await vault('PUT', `sys/policies/acl/${policy}`, { policy: hcl })).status).toBe(204);
    policies.push(policy);
    const token = await childToken(policy);
    const tokenFile = join(dir, `${key}.token`);
    await writeFile(tokenFile, token, { mode: 0o600 }); // 0o400 in prod; V9 rewrites it here
    return { key, token, tokenFile, policy };
  }

  async function childToken(policy: string): Promise<string> {
    const res = await vault('POST', 'auth/token/create', {
      policies: [policy],
      no_default_policy: true,
      ttl: '15m',
    });
    expect(res.status).toBe(200);
    return (res.body.auth as { client_token: string }).client_token;
  }

  const cfgFor = (key: string, tokenFile: string): VaultConfig => ({
    addr: ADDR,
    tokenFile,
    mount: MOUNT,
    key,
    timeoutMs: 2000,
  });

  async function provider(
    k: { key: string; tokenFile: string },
    opts: { ttl?: number; fetchFn?: typeof fetch; now?: () => number } = {},
  ): Promise<VaultTransitKeyProvider> {
    const p = new VaultTransitKeyProvider(cfgFor(k.key, k.tokenFile), opts.ttl ?? TTL, opts);
    await p.init();
    return p;
  }

  const metadata = async (key: string) =>
    (await vault('GET', `${MOUNT}/keys/${key}`)).body.data as {
      latest_version: number;
      keys: Record<string, { creation_time: string }>;
    };

  it('V1: TokenSigner signs RS256 PKCS#1 v1.5 via Transit; kid = RFC 7638 thumbprint; PSS does not verify', async () => {
    const k = await newKey();
    const p = await provider(k);
    const token = await new TokenSigner(p, config).sign(
      { scope: 'read' },
      { audience: AUD, subject: 'usr_1', expiresInSec: 60 },
    );
    const keys = await p.getPublicKeys();
    expect(keys).toHaveLength(1);
    const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet({ keys }), {
      issuer: ISSUER,
      audience: AUD,
      algorithms: ['RS256'],
    });
    expect(payload).toMatchObject({ sub: 'usr_1', scope: 'read' });
    expect(protectedHeader).toEqual({ alg: 'RS256', kid: keys[0].kid, typ: 'JWT' });
    const { kty, n, e } = keys[0];
    expect(keys[0].kid).toBe(await calculateJwkThumbprint({ kty, n, e } as JWK, 'sha256'));

    const [h, b, s] = token.split('.');
    const input = Buffer.from(`${h}.${b}`);
    const pub = createPublicKey({ key: { ...keys[0] }, format: 'jwk' });
    const sig = Buffer.from(s, 'base64url');
    expect(verify('sha256', input, pub, sig)).toBe(true);
    expect(
      verify('sha256', input, { key: pub, padding: constants.RSA_PKCS1_PSS_PADDING }, sig),
    ).toBe(false);
    // INV-19: JWKS has public members only.
    expect(Object.keys(keys[0]).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
  });

  it('V2: normal rotation — new kid signs, old token still verifies, retireAt = createdAt(new) + TTL + 30 s, then leaves JWKS', async () => {
    const k = await newKey();
    let offset = 0;
    const p = await provider(k, { ttl: 2, now: () => Date.now() + offset });
    const signer = new TokenSigner(p, config);
    const verifier = new TokenVerifier(p, config);
    const old = await signer.sign({}, { audience: AUD, expiresInSec: 600 });

    const r = await p.rotate('normal', 2);
    expect(r.oldKid).toBe(decodeProtectedHeader(old).kid);
    const fresh = await signer.sign({}, { audience: AUD, expiresInSec: 600 });
    expect(decodeProtectedHeader(fresh).kid).toBe(r.newKid);
    expect(r.newKid).not.toBe(r.oldKid);
    await expect(verifier.verify(old, AUD)).resolves.toBeDefined();
    await expect(verifier.verify(fresh, AUD)).resolves.toBeDefined();

    const md = await metadata(k.key);
    const createdNew = Date.parse(md.keys[String(md.latest_version)].creation_time);
    const list = await p.listKeys();
    expect(list.map((x) => [x.kid, x.status])).toEqual([
      [r.oldKid, 'retiring'],
      [r.newKid, 'active'],
    ]);
    expect(Date.parse(list[0].retireAt!)).toBe(createdNew + 2000 + KEY_CACHE_TTL_MS);

    offset = createdNew + 2000 + KEY_CACHE_TTL_MS + 1 - Date.now();
    expect((await p.getPublicKeys()).map((x) => x.kid)).toEqual([r.newKid]);
    await expect(verifier.verify(old, AUD)).rejects.toThrow();
  });

  it('V3: emergency rotation — JWKS only the new kid at once, old token fails, Vault refuses the old version, old material trimmed', async () => {
    const k = await newKey();
    const p = await provider(k);
    const signer = new TokenSigner(p, config);
    const verifier = new TokenVerifier(p, config);
    const old = await signer.sign({}, { audience: AUD, expiresInSec: 600 });

    const r = await p.rotate('emergency', TTL);
    expect((await p.getPublicKeys()).map((x) => x.kid)).toEqual([r.newKid]);
    await expect(verifier.verify(old, AUD)).rejects.toThrow();

    const direct = await vault(
      'POST',
      `${MOUNT}/sign/${k.key}`,
      {
        input: Buffer.from('x').toString('base64'),
        key_version: 1,
        hash_algorithm: 'sha2-256',
        signature_algorithm: 'pkcs1v15',
      },
      k.token,
    );
    expect(direct.status).toBeGreaterThanOrEqual(400);
    const md = await metadata(k.key);
    expect(Object.keys(md.keys)).toEqual([String(md.latest_version)]);
  });

  it('V3b: emergency whose trim fails — min_decryption_version alone keeps the old kid out of JWKS', async () => {
    const k = await newKey();
    const { fetchFn } = countingFetch();
    const failTrim: typeof fetch = (url, init) =>
      String(url).endsWith('/trim')
        ? Promise.resolve(new Response('{}', { status: 500 }))
        : fetchFn(url, init);
    const p = await provider(k, { fetchFn: failTrim });
    const old = await new TokenSigner(p, config).sign({}, { audience: AUD, expiresInSec: 600 });
    const r = await p.rotate('emergency', TTL);
    expect(logs).toContain(`trim failed after emergency rotation (new kid ${r.newKid})`);
    // Not trimmed (old material still in Vault), but min_decryption_version moved: Vault 2.1.2 no
    // longer lists v1 and the provider floor (defence in depth) excludes it too.
    const md = (await vault('GET', `${MOUNT}/keys/${k.key}`)).body.data!;
    expect(md).toMatchObject({ min_available_version: 0, min_decryption_version: 2 });
    expect((await p.getPublicKeys()).map((x) => x.kid)).toEqual([r.newKid]);
    await expect(new TokenVerifier(p, config).verify(old, AUD)).rejects.toThrow();
  });

  it('V4: two instances — B (stale cache) verifies A’s new-kid token via the kid hint; 50 random kids ⇒ ≤ 1 Vault read', async () => {
    const k = await newKey();
    const a = await provider(k);
    const counted = countingFetch();
    const b = await provider(k, { fetchFn: counted.fetchFn });
    await a.rotate('normal', TTL);
    const token = await new TokenSigner(a, config).sign({}, { audience: AUD, expiresInSec: 60 });
    await expect(new TokenVerifier(b, config).verify(token, AUD)).resolves.toBeDefined();

    counted.calls.length = 0;
    for (let i = 0; i < 50; i++) await b.getPublicKeys(randomBytes(16).toString('base64url'));
    expect(counted.calls.filter((c) => c === 'read').length).toBeLessThanOrEqual(1);
  });

  it('V5: emergency on A; B with a stale cache signs with the NEW kid (Vault refuses the old version ⇒ refresh ⇒ re-sign)', async () => {
    const k = await newKey();
    const a = await provider(k);
    const b = await provider(k);
    const r = await a.rotate('emergency', TTL);
    const token = await new TokenSigner(b, config).sign({}, { audience: AUD, expiresInSec: 60 });
    expect(decodeProtectedHeader(token).kid).toBe(r.newKid);
    await expect(new TokenVerifier(a, config).verify(token, AUD)).resolves.toBeDefined();
  });

  it('V6: the app token cannot export, make exportable, allow deletion, delete, or use another key', async () => {
    const k = await newKey();
    const other = await newKey();
    const as = (method: string, path: string, body?: unknown) => vault(method, path, body, k.token);
    expect((await as('GET', `${MOUNT}/export/signing-key/${k.key}`)).status).toBe(403);
    expect((await as('POST', `${MOUNT}/keys/${k.key}/config`, { exportable: true })).status).toBe(
      403,
    );
    expect(
      (await as('POST', `${MOUNT}/keys/${k.key}/config`, { deletion_allowed: true })).status,
    ).toBe(403);
    expect(
      (await as('POST', `${MOUNT}/keys/${k.key}/config`, { allow_plaintext_backup: true })).status,
    ).toBe(403);
    expect((await as('DELETE', `${MOUNT}/keys/${k.key}`)).status).toBe(403);
    expect((await as('GET', `${MOUNT}/backup/${k.key}`)).status).toBe(403);
    expect(
      (
        await as('POST', `${MOUNT}/sign/${other.key}`, {
          input: 'eA==',
          hash_algorithm: 'sha2-256',
          signature_algorithm: 'pkcs1v15',
        })
      ).status,
    ).toBe(403);
    // The allowed parameters still work (the emergency path needs them).
    expect(
      (await as('POST', `${MOUNT}/keys/${k.key}/config`, { min_decryption_version: 1 })).status,
    ).toBeLessThan(300);
    const md = (await vault('GET', `${MOUNT}/keys/${k.key}`)).body.data!;
    expect(md).toMatchObject({ exportable: false, deletion_allowed: false });
  });

  it.each([
    ['exportable', { exportable: true }],
    ['allow_plaintext_backup', { exportable: true, allow_plaintext_backup: true }],
    ['aes256-gcm96', { type: 'aes256-gcm96' }],
  ])('V7: key %s ⇒ init throws (app does not boot)', async (_n, create) => {
    const k = await newKey(create);
    await expect(provider(k)).rejects.toThrow();
  });

  it('V7: full app with an exportable key does not boot', async () => {
    const k = await newKey({ exportable: true });
    await expect(
      bootFullApp({
        name: 'vault-v7',
        env: {
          KEY_PROVIDER: 'vault',
          VAULT_ADDR: ADDR,
          VAULT_TOKEN_FILE: k.tokenFile,
          VAULT_TRANSIT_MOUNT: MOUNT,
          VAULT_TRANSIT_KEY: k.key,
        },
      }),
    ).rejects.toThrow(/exportable/);
  });

  it('V8: missing key / missing token file / wrong token ⇒ init throws; nothing secret in errors or logs', async () => {
    const k = await newKey();
    const errs: string[] = [];
    const fail = async (p: Promise<unknown>) =>
      errs.push(((await p.catch((e) => e)) as Error).message);
    // A key this token is allowed to read, deleted by ops (root) ⇒ 404 (not 403).
    const gone = await newKey();
    await vault('POST', `${MOUNT}/keys/${gone.key}/config`, { deletion_allowed: true });
    expect((await vault('DELETE', `${MOUNT}/keys/${gone.key}`)).status).toBe(204);
    await fail(provider(gone));
    await fail(provider({ key: k.key, tokenFile: join(dir, 'absent.token') }));
    const wrong = join(dir, 'wrong.token');
    await writeFile(wrong, 'hvs.not-a-valid-token-0000000000000');
    await fail(provider({ key: k.key, tokenFile: wrong }));
    expect(errs).toEqual([
      'vault read failed: status=404',
      expect.stringMatching(/^Vault token file could not be read/),
      'vault read failed: status=403',
    ]);
    for (const m of errs) {
      expect(m).not.toContain(k.token);
      expect(m).not.toContain(dir);
      expect(m).not.toContain('not-a-valid-token');
    }
    for (const line of logs) expect(line).not.toContain('not-a-valid-token');
  });

  it('V9: token revoked + new token in the file ⇒ 403 ⇒ re-read ⇒ success; still revoked ⇒ throw after exactly 2 calls', async () => {
    const k = await newKey();
    const counted = countingFetch();
    const p = await provider(k, { fetchFn: counted.fetchFn });
    expect((await vault('POST', 'auth/token/revoke', { token: k.token })).status).toBe(204);
    const second = await childToken(k.policy);
    await writeFile(k.tokenFile, second);

    counted.calls.length = 0;
    await expect(p.signJwt({ typ: 'JWT' }, { sub: 'x' })).resolves.toMatch(/^ey/);
    expect(counted.calls).toEqual(['sign', 'sign']);

    expect((await vault('POST', 'auth/token/revoke', { token: second })).status).toBe(204);
    counted.calls.length = 0;
    await expect(p.signJwt({ typ: 'JWT' }, {})).rejects.toThrow('vault sign failed: status=403');
    expect(counted.calls).toEqual(['sign', 'sign']);
  });

  it('V14: full app with KEY_PROVIDER=vault — /jwks.json serves the Vault key, /token tokens verify, /userinfo accepts the access token', async () => {
    const k = await newKey();
    const full = await bootFullApp({
      name: 'vault-v14',
      env: {
        KEY_PROVIDER: 'vault',
        VAULT_ADDR: ADDR,
        VAULT_TOKEN_FILE: k.tokenFile,
        VAULT_TRANSIT_MOUNT: MOUNT,
        VAULT_TRANSIT_KEY: k.key,
      },
    });
    try {
      const jwksRes = await full.app.inject({ method: 'GET', url: '/jwks.json' });
      expect(jwksRes.statusCode).toBe(200);
      const jwks = jwksRes.json<{ keys: JWK[] }>();
      const vaultKeys = (await vault('GET', `${MOUNT}/keys/${k.key}`)).body.data!.keys as Record<
        string,
        { public_key: string }
      >;
      const expected = createPublicKey(vaultKeys['1'].public_key).export({ format: 'jwk' });
      expect(jwks.keys).toHaveLength(1);
      expect(jwks.keys[0]).toMatchObject({ kty: 'RSA', n: expected.n, e: expected.e });

      const client = await seedFlowClient(full);
      const userId = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
      await seedConsent(full.conn, {
        userId,
        clientId: client.clientId,
        resource: FLOW_API_AUD,
        scopes: ['openid', 'api.read'],
      });
      const sessionId = (await full.app.get(SessionService).create(userId, DEFAULT_TENANT_ID)).id;
      const verifier = randomBytes(32).toString('base64url');
      const code = await authorizeCode(full, {
        ...client,
        sessionId,
        resource: FLOW_API_AUD,
        scope: 'openid api.read',
        verifier,
      });
      const tok = await formPost(full, '/token', client, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: FLOW_REDIRECT,
        code_verifier: verifier,
      });
      expect(tok.statusCode).toBe(200);
      const { id_token, access_token } = tok.json<{ id_token: string; access_token: string }>();
      const set = createLocalJWKSet({ keys: jwks.keys });
      await expect(
        jwtVerify(id_token, set, {
          issuer: ISSUER,
          audience: client.clientId,
          algorithms: ['RS256'],
        }),
      ).resolves.toBeDefined();
      await expect(
        jwtVerify(access_token, set, {
          issuer: ISSUER,
          audience: FLOW_API_AUD,
          algorithms: ['RS256'],
          typ: 'at+jwt',
        }),
      ).resolves.toBeDefined();
      const ui = await full.app.inject({
        method: 'GET',
        url: '/userinfo',
        headers: { authorization: `Bearer ${access_token}` },
      });
      expect(ui.statusCode).toBe(200);
      expect(ui.json()).toMatchObject({ sub: userId });
    } finally {
      await full.close();
    }
  });
});
