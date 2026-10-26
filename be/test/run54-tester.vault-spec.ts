import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { KEY_PROVIDER } from '../src/modules/keys/key-provider';
import { VaultTransitKeyProvider } from '../src/modules/keys/vault-transit-key-provider';
import { SessionService } from '../src/modules/sessions/session.service';
import {
  authorizeCode,
  bootFullApp,
  FLOW_API_AUD,
  FLOW_REDIRECT,
  formPost,
  seedFlowClient,
  type FullApp,
  type InjectResponse,
} from './full-app';
import { seedConsent, seedOAuthUser } from './oauth-fixtures';

/**
 * Tester risk tests, run 54 (DEBT-401 classification seen from HTTP, on a real Vault). The real
 * Vault answers every call; a fetch shim in front of the provider replaces the answer of ONE path
 * (sign or key metadata) with a chosen status or a network error. Checks, end to end through the
 * full app: Vault 400/403 ⇒ `/token` (both grants) and `/jwks.json` 500 server_error (operator
 * problem, not retryable); 429/503/network ⇒ 503 temporarily_unavailable + Retry-After + no-store;
 * never a token/JWK in the body; after every failure the same code and the same RT still work and
 * nothing is reuse (DEBT-388). Finally a REAL Vault 403 (child token revoked) ⇒ 500.
 */

const ADDR = process.env.VAULT_TEST_ADDR!;
const ROOT = process.env.VAULT_TEST_ROOT_TOKEN!;
const MOUNT = `vg-r54t-${randomBytes(4).toString('hex')}`;
const OUTAGE = {
  error: 'temporarily_unavailable',
  error_description: 'The service is temporarily unavailable. Try again later.',
};

async function vault(method: string, path: string, body?: unknown) {
  const res = await fetch(`${ADDR}/v1/${path}`, {
    method,
    headers: { 'X-Vault-Token': ROOT, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

type Fault = { path: RegExp; status: number | 'network' } | null;

describe('run 54 tester: Vault 4xx vs outage classification through /token and /jwks.json', () => {
  let dir: string;
  let policy: string;
  let key: string;
  let token: string;
  let tokenFile: string;
  let full: FullApp;
  let client: { clientId: string; secret: string };
  let sessionId: string;
  let fault: Fault = null;
  let offset = 0;
  const logs: string[] = [];
  const pino: string[] = [];

  const shim: typeof fetch = async (input, init) => {
    const url = String(input);
    if (fault && fault.path.test(new URL(url).pathname)) {
      if (fault.status === 'network') throw new TypeError('fetch failed');
      return new Response('{"errors":["injected"]}', { status: fault.status });
    }
    return fetch(input, init);
  };

  beforeAll(async () => {
    expect((await vault('POST', `sys/mounts/${MOUNT}`, { type: 'transit' })).status).toBe(204);
    key = `k-${randomUUID()}`;
    expect(
      (await vault('POST', `${MOUNT}/keys/${key}`, { type: 'rsa-2048', exportable: false })).status,
    ).toBeLessThan(300);
    const hcl = (
      await readFile(join(process.cwd(), '..', 'ops', 'vault', 'idp-signer.hcl'), 'utf8')
    )
      .replaceAll('<mount>', MOUNT)
      .replaceAll('<key>', key);
    policy = `p-${key}`;
    expect((await vault('PUT', `sys/policies/acl/${policy}`, { policy: hcl })).status).toBe(204);
    const created = await vault('POST', 'auth/token/create', {
      policies: [policy],
      no_default_policy: true,
      ttl: '15m',
    });
    token = created.body.auth.client_token as string;
    dir = await mkdtemp(join(tmpdir(), 'vg-r54t-'));
    tokenFile = join(dir, 'token');
    await writeFile(tokenFile, token, { mode: 0o600 });

    const cfg = { addr: ADDR, tokenFile, mount: MOUNT, key, timeoutMs: 2000 };
    full = await bootFullApp({
      name: 'r54t',
      logStream: new Writable({
        write(chunk, _e, cb) {
          pino.push(String(chunk));
          cb();
        },
      }),
      env: {
        KEY_PROVIDER: 'vault',
        VAULT_ADDR: ADDR,
        VAULT_TOKEN_FILE: tokenFile,
        VAULT_TRANSIT_MOUNT: MOUNT,
        VAULT_TRANSIT_KEY: key,
      },
      override: (b) =>
        b.overrideProvider(KEY_PROVIDER).useFactory({
          factory: async () => {
            const p = new VaultTransitKeyProvider(cfg, 900, {
              fetchFn: shim,
              now: () => Date.now() + offset,
            });
            await p.init();
            return p;
          },
        }),
    });
    client = await seedFlowClient(full);
    const userId = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
    await seedConsent(full.conn, {
      userId,
      clientId: client.clientId,
      resource: FLOW_API_AUD,
      scopes: ['openid', 'offline_access', 'api.read'],
    });
    sessionId = (await full.app.get(SessionService).create(userId, DEFAULT_TENANT_ID)).id;
  }, 60_000);

  const newCode = async () => {
    const verifier = randomBytes(32).toString('base64url');
    const code = await authorizeCode(full, {
      ...client,
      sessionId,
      resource: FLOW_API_AUD,
      scope: 'openid offline_access api.read',
      verifier,
    });
    return () =>
      formPost(full, '/token', client, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: FLOW_REDIRECT,
        code_verifier: verifier,
      });
  };

  afterAll(async () => {
    if (full) await full.close();
    await vault('DELETE', `sys/policies/acl/${policy}`);
    await vault('DELETE', `sys/mounts/${MOUNT}`);
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((msg: unknown) => void logs.push(String(msg)));
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fault = null;
    for (const line of [...logs, ...pino]) {
      expect(line).not.toContain(token);
      expect(line).not.toContain(ROOT);
      expect(line).not.toContain(dir);
      expect(line).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./);
    }
  });

  const SIGN = new RegExp(`/v1/${MOUNT}/sign/`);
  const META = new RegExp(`/v1/${MOUNT}/keys/[^/]+$`);

  function expectServerError(res: InjectResponse) {
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: 'server_error' });
    expect(res.headers['retry-after']).toBeUndefined();
    expect(res.body).not.toMatch(/eyJ|access_token|refresh_token|"kty"/);
  }
  function expectOutage(res: InjectResponse) {
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(String(res.headers['cache-control'])).toContain('no-store');
    expect(JSON.parse(res.body)).toEqual(OUTAGE);
    expect(res.body).not.toMatch(/eyJ|access_token|refresh_token|"kty"/);
  }

  it('V1: /token code + refresh grants — Vault sign 400/403 ⇒ 500, 429/502/503/network ⇒ 503; each time the same code and RT stay usable; 0 reuse', async () => {
    const first = await (await newCode())();
    expect(first.statusCode).toBe(200);
    let rt = first.json<{ refresh_token: string }>().refresh_token;
    const reuse = () =>
      full.conn
        .model('AuditLog')
        .countDocuments({ action: 'TOKEN_REUSE_DETECTED', clientId: client.clientId });

    const cases: Array<[number | 'network', 'server' | 'outage']> = [
      [400, 'server'],
      [403, 'server'],
      [429, 'outage'],
      [502, 'outage'],
      [503, 'outage'],
      ['network', 'outage'],
    ];
    for (const [status, kind] of cases) {
      const exchange = await newCode();
      const refresh = () =>
        formPost(full, '/token', client, { grant_type: 'refresh_token', refresh_token: rt });
      fault = { path: SIGN, status };
      const check = kind === 'server' ? expectServerError : expectOutage;
      check(await exchange());
      check(await refresh());
      fault = null;
      const again = await exchange();
      expect([status, again.statusCode]).toEqual([status, 200]);
      const rotated = await refresh();
      expect([status, rotated.statusCode]).toEqual([status, 200]);
      rt = rotated.json<{ refresh_token: string }>().refresh_token;
      expect(await reuse()).toBe(0);
    }
  });

  it('V2: /jwks.json with the metadata cache expired — Vault 400/403 ⇒ 500, 429/503/network ⇒ 503 + Retry-After + no-store; recovers', async () => {
    expect((await full.app.inject({ method: 'GET', url: '/jwks.json' })).statusCode).toBe(200);
    offset += 31_000; // key-set cache (30 s) expired
    const cases: Array<[number | 'network', 'server' | 'outage']> = [
      [400, 'server'],
      [403, 'server'],
      [429, 'outage'],
      [503, 'outage'],
      ['network', 'outage'],
    ];
    for (const [status, kind] of cases) {
      fault = { path: META, status };
      const res = (await full.app.inject({ method: 'GET', url: '/jwks.json' })) as InjectResponse;
      if (kind === 'server') expectServerError(res);
      else expectOutage(res);
    }
    fault = null;
    const ok = await full.app.inject({ method: 'GET', url: '/jwks.json' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ keys: unknown[] }>().keys.length).toBeGreaterThan(0);
  });

  it('V3: a REAL Vault 403 (child token revoked; the token-file re-read gives the same token) ⇒ /token 500 server_error, not 503, no token, code still intact', async () => {
    const exchange = await newCode();
    expect((await vault('POST', 'auth/token/revoke', { token })).status).toBe(204);
    expectServerError(await exchange());
    expectServerError(await exchange()); // the code was not consumed by the failed sign
  });
});
