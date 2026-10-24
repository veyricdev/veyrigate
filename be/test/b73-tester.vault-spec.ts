import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  jwtVerify,
  SignJWT,
  type JWK,
} from 'jose';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, connect, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { Writable } from 'node:stream';
import { validateEnv } from '../src/config/validation.schema';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { KEY_PROVIDER, type KeyProvider } from '../src/modules/keys/key-provider';
import { VaultTransitKeyProvider } from '../src/modules/keys/vault-transit-key-provider';
import { SessionService } from '../src/modules/sessions/session.service';
import {
  authorizeCode,
  bootFullApp,
  FLOW_API_AUD,
  FLOW_REDIRECT,
  FULL_APP_ISSUER,
  formPost,
  seedFlowClient,
  type FullApp,
} from './full-app';
import { seedConsent, seedOAuthUser } from './oauth-fixtures';

/**
 * Tester risk tests, run 53 (B7.3 part 1, Vault Transit KeyProvider). Opt-in via `test:vault`, same
 * Vault preflight as `vault-transit.vault-spec.ts`. Adds what the dev suite does not cover at the
 * full-app level: a standard remote-JWKS client + /introspect, alg confusion with a REAL kid
 * (including a genuine PSS signature from the same Transit key), a kid storm through /userinfo,
 * emergency rotation end-to-end, Vault-down fail-closed (DEBT-394 characterisation), token
 * exposure (inspect/JSON/logs/errors) and DEBT-395 characterisation.
 */

const ADDR = process.env.VAULT_TEST_ADDR!;
const ROOT = process.env.VAULT_TEST_ROOT_TOKEN!;
const VAULT_URL = new URL(ADDR);
const MOUNT = `vg-b73t-${randomBytes(4).toString('hex')}`;

async function vault(method: string, path: string, body?: unknown, token = ROOT) {
  const res = await fetch(`${ADDR}/v1/${path}`, {
    method,
    headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : {}) as Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** In-process TCP proxy to Vault that can be cut (connection refused) and restored on the same port. */
class CuttableProxy {
  private server?: Server;
  private sockets = new Set<Socket>();
  port = 0;
  async up(): Promise<void> {
    this.server = createServer((client) => {
      const upstream = connect(Number(VAULT_URL.port), VAULT_URL.hostname);
      for (const s of [client, upstream]) {
        this.sockets.add(s);
        s.on('close', () => this.sockets.delete(s));
        s.on('error', () => s.destroy());
      }
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((r) => this.server!.listen(this.port, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
  }
  async down(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server!.close(() => r()));
  }
}

describe('run 53 tester: Vault Transit KeyProvider risk tests', () => {
  let dir: string;
  let policyTemplate: string;
  const policies: string[] = [];
  let logs: string[];
  let pinoOut: string[];
  const childTokens: string[] = [];
  const realNow = Date.now.bind(Date);
  let offset = 0;

  beforeAll(async () => {
    expect((await vault('POST', `sys/mounts/${MOUNT}`, { type: 'transit' })).status).toBe(204);
    policyTemplate = await readFile(
      join(process.cwd(), '..', 'ops', 'vault', 'idp-signer.hcl'),
      'utf8',
    );
    dir = await mkdtemp(join(tmpdir(), 'vg-b73t-'));
  });

  afterAll(async () => {
    for (const p of policies) await vault('DELETE', `sys/policies/acl/${p}`);
    await vault('DELETE', `sys/mounts/${MOUNT}`);
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    logs = [];
    pinoOut = [];
    offset = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    for (const level of ['log', 'warn', 'error'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((msg: unknown) => void logs.push(String(msg)));
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    // Exposure invariant: no Vault token (root or child), no token-file path in any log sink.
    for (const line of [...logs, ...pinoOut]) {
      expect(line).not.toContain(ROOT);
      expect(line).not.toMatch(/hvs\./);
      expect(line).not.toContain(dir);
      for (const t of childTokens) expect(line).not.toContain(t);
    }
  });

  async function newKey(): Promise<{ key: string; token: string; tokenFile: string }> {
    const key = `k-${randomUUID()}`;
    expect(
      (await vault('POST', `${MOUNT}/keys/${key}`, { type: 'rsa-2048', exportable: false })).status,
    ).toBeLessThan(300);
    const policy = `p-${key}`;
    const hcl = policyTemplate.replaceAll('<mount>', MOUNT).replaceAll('<key>', key);
    expect((await vault('PUT', `sys/policies/acl/${policy}`, { policy: hcl })).status).toBe(204);
    policies.push(policy);
    const res = await vault('POST', 'auth/token/create', {
      policies: [policy],
      no_default_policy: true,
      ttl: '15m',
    });
    const token = res.body.auth.client_token as string;
    childTokens.push(token);
    const tokenFile = join(dir, `${key}.token`);
    await writeFile(tokenFile, token, { mode: 0o600 });
    return { key, token, tokenFile };
  }

  const logStream = () =>
    new Writable({
      write(chunk, _e, cb) {
        pinoOut.push(String(chunk));
        cb();
      },
    });

  async function bootVault(k: { key: string; tokenFile: string }, addr = ADDR): Promise<FullApp> {
    return bootFullApp({
      name: 'b73t',
      logStream: logStream(),
      env: {
        KEY_PROVIDER: 'vault',
        VAULT_ADDR: addr,
        VAULT_TOKEN_FILE: k.tokenFile,
        VAULT_TRANSIT_MOUNT: MOUNT,
        VAULT_TRANSIT_KEY: k.key,
      },
    });
  }

  /** code flow ⇒ {access_token, id_token} + the client (can introspect its own tokens). */
  async function issue(
    full: FullApp,
    seeded?: { client: { clientId: string; secret: string }; userId: string },
  ) {
    const client = seeded?.client ?? (await seedFlowClient(full));
    const userId =
      seeded?.userId ?? (await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID }));
    if (!seeded) {
      await seedConsent(full.conn, {
        userId,
        clientId: client.clientId,
        resource: FLOW_API_AUD,
        scopes: ['openid', 'api.read'],
      });
    }
    const sessionId = (await full.app.get(SessionService).create(userId, DEFAULT_TENANT_ID)).id;
    const verifier = randomBytes(32).toString('base64url');
    const code = await authorizeCode(full, {
      ...client,
      sessionId,
      resource: FLOW_API_AUD,
      scope: 'openid api.read',
      verifier,
    });
    const res = await formPost(full, '/token', client, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: FLOW_REDIRECT,
      code_verifier: verifier,
    });
    return { res, client, userId };
  }

  const userinfo = (full: FullApp, at: string) =>
    full.app.inject({
      method: 'GET',
      url: '/userinfo',
      headers: { authorization: `Bearer ${at}` },
    });
  const introspect = async (
    full: FullApp,
    client: { clientId: string; secret: string },
    token: string,
  ) => (await formPost(full, '/introspect', client, { token })).json<{ active: boolean }>();

  it('T1: Vault-signed tokens verify with a standard remote JWKS client (createRemoteJWKSet over HTTP), /userinfo and /introspect', async () => {
    const k = await newKey();
    const full = await bootVault(k);
    try {
      await full.app.listen(0, '127.0.0.1');
      const port = (full.app.getHttpServer().address() as AddressInfo).port;
      const { res, client } = await issue(full);
      expect(res.statusCode).toBe(200);
      const { access_token, id_token } = res.json<{ access_token: string; id_token: string }>();
      const jwks = createRemoteJWKSet(new URL(`http://127.0.0.1:${port}/jwks.json`));
      await expect(
        jwtVerify(access_token, jwks, {
          issuer: FULL_APP_ISSUER,
          audience: FLOW_API_AUD,
          algorithms: ['RS256'],
          typ: 'at+jwt',
        }),
      ).resolves.toBeDefined();
      await expect(
        jwtVerify(id_token, jwks, {
          issuer: FULL_APP_ISSUER,
          audience: client.clientId,
          algorithms: ['RS256'],
        }),
      ).resolves.toBeDefined();
      expect((await userinfo(full, access_token)).statusCode).toBe(200);
      expect((await introspect(full, client, access_token)).active).toBe(true);
    } finally {
      await full.close();
    }
  });

  it('T2: alg none / HS256 / PS256 (genuine Transit PSS signature) with the VALID Vault kid ⇒ /userinfo 401, /introspect inactive', async () => {
    const k = await newKey();
    const full = await bootVault(k);
    try {
      const { res, client } = await issue(full);
      const { access_token } = res.json<{ access_token: string }>();
      const real = decodeProtectedHeader(access_token);
      const payload = decodeJwt(access_token);
      const jwk = (await full.app.inject({ method: 'GET', url: '/jwks.json' })).json<{
        keys: JWK[];
      }>().keys[0];
      expect(jwk.kid).toBe(real.kid);

      const none = `${b64u({ alg: 'none', kid: real.kid, typ: 'at+jwt' })}.${b64u(payload)}.`;
      // Classic RS/HS confusion: HMAC keyed with the public modulus / the public JWK JSON.
      const hsN = await new SignJWT(payload)
        .setProtectedHeader({ alg: 'HS256', kid: real.kid!, typ: 'at+jwt' })
        .sign(Buffer.from(jwk.n!, 'base64url'));
      const hsJson = await new SignJWT(payload)
        .setProtectedHeader({ alg: 'HS256', kid: real.kid!, typ: 'at+jwt' })
        .sign(Buffer.from(JSON.stringify(jwk)));
      // PS256 signed by the SAME Transit key (root token): a genuine signature, only the alg differs.
      const input = `${b64u({ alg: 'PS256', kid: real.kid, typ: 'at+jwt' })}.${b64u(payload)}`;
      const signed = await vault('POST', `${MOUNT}/sign/${k.key}`, {
        input: Buffer.from(input).toString('base64'),
        key_version: 1,
        hash_algorithm: 'sha2-256',
        signature_algorithm: 'pss',
        salt_length: 'hash',
      });
      expect(signed.status).toBe(200);
      const ps = `${input}.${Buffer.from(String(signed.body.data.signature).split(':')[2], 'base64').toString('base64url')}`;
      // Sanity: the PS256 token IS cryptographically valid if one (wrongly) allowed PS256.
      await expect(
        jwtVerify(ps, createLocalJWKSet({ keys: [{ ...jwk, alg: 'PS256' }] }), {
          algorithms: ['PS256'],
        }),
      ).resolves.toBeDefined();

      for (const forged of [none, hsN, hsJson, ps]) {
        const ui = await userinfo(full, forged);
        expect(ui.statusCode).toBe(401);
        expect(ui.body).not.toContain(String(payload.sub));
        expect((await introspect(full, client, forged)).active).toBe(false);
      }
      // The genuine token still works (the rejections are about alg, not a broken setup).
      expect((await userinfo(full, access_token)).statusCode).toBe(200);
    } finally {
      await full.close();
    }
  });

  it('T3: kid storm through /userinfo ⇒ ≤ 1 Vault read per 5 s cooldown (no amplification)', async () => {
    const k = await newKey();
    const realFetch = globalThis.fetch;
    const reads: number[] = [];
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
      if (
        String(url).startsWith(ADDR) &&
        (init?.method ?? 'GET') === 'GET' &&
        String(url).includes(`/keys/${k.key}`)
      )
        reads.push(1);
      return realFetch(url, init);
    }) as typeof fetch;
    let full: FullApp | undefined;
    try {
      full = await bootVault(k); // provider captures the counting fetch
      const storm = async () => {
        for (let i = 0; i < 50; i++) {
          const t = `${b64u({ alg: 'RS256', kid: randomBytes(16).toString('base64url'), typ: 'at+jwt' })}.${b64u({ sub: 'x' })}.${randomBytes(256).toString('base64url')}`;
          expect((await userinfo(full!, t)).statusCode).toBe(401);
        }
      };
      reads.length = 0;
      await storm();
      expect(reads.length).toBeLessThanOrEqual(1);
      offset += 5_001; // next cooldown window (still inside the 30 s cache TTL)
      reads.length = 0;
      await storm();
      expect(reads.length).toBeLessThanOrEqual(1);
    } finally {
      globalThis.fetch = realFetch;
      await full?.close();
    }
  });

  it('T4: emergency rotation (full app) ⇒ old token 401 / inactive, new token OK, JWKS only the new kid', async () => {
    const k = await newKey();
    const full = await bootVault(k);
    try {
      await full.app.listen(0, '127.0.0.1');
      const port = (full.app.getHttpServer().address() as AddressInfo).port;
      const first = await issue(full);
      const old = first.res.json<{ access_token: string }>().access_token;
      expect((await userinfo(full, old)).statusCode).toBe(200);

      const r = await full.app.get<KeyProvider>(KEY_PROVIDER).rotate('emergency', 900);
      expect(r.oldKid).toBe(decodeProtectedHeader(old).kid);

      const jwks = (await full.app.inject({ method: 'GET', url: '/jwks.json' })).json<{
        keys: JWK[];
      }>();
      expect(jwks.keys.map((x) => x.kid)).toEqual([r.newKid]);
      expect((await userinfo(full, old)).statusCode).toBe(401);
      expect((await introspect(full, first.client, old)).active).toBe(false);

      const second = await issue(full, { client: first.client, userId: first.userId });
      expect(second.res.statusCode).toBe(200);
      const fresh = second.res.json<{ access_token: string }>().access_token;
      expect(decodeProtectedHeader(fresh).kid).toBe(r.newKid);
      expect((await userinfo(full, fresh)).statusCode).toBe(200);
      expect((await introspect(full, first.client, fresh)).active).toBe(true);
      const remote = createRemoteJWKSet(new URL(`http://127.0.0.1:${port}/jwks.json`));
      await expect(jwtVerify(fresh, remote, { algorithms: ['RS256'] })).resolves.toBeDefined();
      await expect(jwtVerify(old, remote, { algorithms: ['RS256'] })).rejects.toThrow();
      const md = (await vault('GET', `${MOUNT}/keys/${k.key}`)).body.data;
      expect(Object.keys(md.keys)).toEqual(['2']);
    } finally {
      await full.close();
    }
  });

  it('T5: Vault down ⇒ fail-closed: /token 5xx without tokens; verify works from cache ≤ 30 s, then 503 (DEBT-394, run 53c); recovers', async () => {
    const k = await newKey();
    const proxy = new CuttableProxy();
    await proxy.up();
    const full = await bootVault(k, `http://127.0.0.1:${proxy.port}`);
    try {
      const ok = await issue(full);
      const at = ok.res.json<{ access_token: string }>().access_token;
      await proxy.down();

      const failed = await issue(full, { client: ok.client, userId: ok.userId });
      expect(failed.res.statusCode).toBeGreaterThanOrEqual(500);
      expect(failed.res.body).not.toMatch(/access_token|id_token|refresh_token|eyJ/);

      // Within the cache TTL: verification still served from the cached key set.
      expect((await userinfo(full, at)).statusCode).toBe(200);

      offset += 31_000; // cache expired, Vault still down
      const ui = await userinfo(full, at);
      // DEBT-394 (run 53c): an outage, not a bad token ⇒ 503 + Retry-After, never 401/active:false.
      expect(ui.statusCode).toBe(503);
      expect(ui.headers['retry-after']).toBe('5');
      expect(ui.json()).toMatchObject({ error: 'temporarily_unavailable' });
      const intro = await introspect(full, ok.client, at);
      expect(intro).toEqual({ error: 'temporarily_unavailable' });
      const jwks = await full.app.inject({ method: 'GET', url: '/jwks.json' });
      expect(jwks.statusCode).toBeGreaterThanOrEqual(500); // no stale key set served
      expect(jwks.body).not.toContain('"kty"');
      expect(logs.some((l) => /^vault read failed: /.test(l))).toBe(true);

      await proxy.up(); // same port
      expect((await userinfo(full, at)).statusCode).toBe(200);
    } finally {
      await full.close();
      await proxy.down().catch(() => undefined);
    }
  });

  it('T6: the Vault token never appears in util.inspect / JSON.stringify / error messages / logs', async () => {
    const k = await newKey();
    const p = new VaultTransitKeyProvider(
      { addr: ADDR, tokenFile: k.tokenFile, mount: MOUNT, key: k.key, timeoutMs: 2000 },
      900,
    );
    await p.init();
    const dumps = [
      inspect(p, { depth: 20, showHidden: true, getters: true }),
      inspect(p, { depth: 20, showHidden: false }),
      JSON.stringify(p),
      String(p),
      JSON.stringify(Object.entries(p)),
    ];
    for (const d of dumps) {
      expect(d).not.toContain(k.token);
      expect(d).not.toContain(k.tokenFile);
    }
    // Revoked token ⇒ every failure path: errors and logs carry neither token nor path.
    expect((await vault('POST', 'auth/token/revoke', { token: k.token })).status).toBe(204);
    const errs: unknown[] = [];
    errs.push(await p.signJwt({ typ: 'JWT' }, {}).catch((e) => e));
    errs.push(await p.rotate('normal', 900).catch((e) => e));
    await rm(k.tokenFile);
    errs.push(
      await new VaultTransitKeyProvider(
        { addr: ADDR, tokenFile: k.tokenFile, mount: MOUNT, key: k.key, timeoutMs: 2000 },
        900,
      )
        .init()
        .catch((e) => e),
    );
    for (const e of errs) {
      expect(e).toBeInstanceOf(Error);
      for (const s of [
        inspect(e, { depth: 20, showHidden: true }),
        JSON.stringify(e),
        (e as Error).stack ?? '',
      ]) {
        expect(s).not.toContain(k.token);
        expect(s).not.toContain(dir);
      }
    }
    expect(logs.length).toBeGreaterThan(0);
  });

  it('T7: config — production + vault given VAULT_TOKEN but no VAULT_TOKEN_FILE ⇒ refused naming the variable, value not echoed', () => {
    const canary = 'hvs.b73-canary-value';
    const env = {
      NODE_ENV: 'production',
      ISSUER: 'https://id.example.test',
      MONGO_URI: 'mongodb://localhost:27117/x',
      REDIS_URL: 'redis://localhost:6479',
      ACCESS_TOKEN_TTL: '900',
      REFRESH_TOKEN_TTL: '2592000',
      SESSION_IDLE_TTL: '3600',
      SESSION_ABSOLUTE_TTL: '86400',
      SMTP_URL: 'smtp://mail.internal:25',
      ADMIN_SEED_EMAIL: 'admin@example.test',
      CSRF_SECRET: 'tester-csrf-secret-not-a-real-secret-0000',
      RATE_LIMIT_WINDOW: '60',
      RATE_LIMIT_MAX: '100',
      KEY_PROVIDER: 'vault',
      VAULT_ADDR: 'https://vault.internal:8200',
      VAULT_TRANSIT_KEY: 'idp-signer',
      VAULT_TOKEN: canary,
    };
    let msg = '';
    try {
      validateEnv(env);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/VAULT_TOKEN_FILE/);
    expect(msg).not.toContain(canary);
    // Control: the same env WITH the token file boots (so the failures below are the targeted var).
    expect(validateEnv({ ...env, VAULT_TOKEN_FILE: '/run/vault/token' }).KEY_PROVIDER).toBe(
      'vault',
    );
    for (const [bad, re] of [
      [{ KEY_PROVIDER: 'local', KEY_LOCAL_DIR: '/k' }, /KEY_PROVIDER/],
      [{ VAULT_ADDR: 'http://vault.internal:8200' }, /VAULT_ADDR/],
    ] as const) {
      let m = '';
      try {
        validateEnv({ ...env, VAULT_TOKEN_FILE: '/run/vault/token', ...bad });
      } catch (e) {
        m = (e as Error).message;
      }
      expect(m).toMatch(re);
    }
  });

  it('T8: DEBT-395 — 10 concurrent signJwt while Vault sign answers 500 ⇒ all fail closed; one shared metadata read', async () => {
    const k = await newKey();
    const reads: number[] = [];
    const fetchFn: typeof fetch = (url, init) => {
      if (String(url).includes('/sign/'))
        return Promise.resolve(new Response('{}', { status: 500 }));
      if ((init?.method ?? 'GET') === 'GET') reads.push(1);
      return fetch(url, init);
    };
    const p = new VaultTransitKeyProvider(
      { addr: ADDR, tokenFile: k.tokenFile, mount: MOUNT, key: k.key, timeoutMs: 2000 },
      900,
      { fetchFn },
    );
    await p.init();
    reads.length = 0;
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => p.signJwt({ typ: 'JWT' }, { sub: 'x' })),
    );
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    for (const r of results)
      expect(String((r as PromiseRejectedResult).reason.message)).toBe(
        'vault sign failed: status=500',
      );
    // DEBT-395 (run 53c): the post-failure refresh is single-flight — 1 shared read (+1 transport retry).
    expect(reads.length).toBeLessThanOrEqual(2);
  });
});
