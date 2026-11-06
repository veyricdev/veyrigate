import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { Types } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { KEY_PROVIDER } from '../src/modules/keys/key-provider';
import { KeyRotationService } from '../src/modules/keys/key-rotation.service';
import { VaultTransitKeyProvider } from '../src/modules/keys/vault-transit-key-provider';
import { SessionService } from '../src/modules/sessions/session.service';
import {
  authorizeCode,
  bootFullApp,
  FLOW_ADMIN_AUD,
  FLOW_REDIRECT,
  formPost,
  seedFlowClient,
  type FullApp,
  type InjectResponse,
} from './full-app';
import { seedConsent, seedOAuthUser } from './oauth-fixtures';

/**
 * Tester risk tests, run 55 (DEBT-410) on a REAL Vault through the full app: the admin keys API
 * when Vault is unavailable. A fetch shim in front of the real provider fails chosen Vault paths.
 * - GET /admin/keys: the DEBT-410 window (key-metadata cache expires between the admin guard's
 *   token verification and the controller's `listKeys`) => network/429/503 => 503
 *   temporarily_unavailable + Retry-After 5 + no-store, no key data; Vault 400/403 => 500.
 * - POST /admin/keys/rotate with Vault down => 500 (never 503, the mutation may have run) +
 *   audited `SIGNING_KEY_ROTATED failure`; the Vault key version is unchanged.
 * - no Vault token / root token / JWT in any log line.
 */
const ADDR = process.env.VAULT_TEST_ADDR!;
const ROOT = process.env.VAULT_TEST_ROOT_TOKEN!;
const MOUNT = `vg-r55t-${randomBytes(4).toString('hex')}`;
const ADMIN_SCOPE = 'openid admin.read admin.write offline_access';
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./;
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

describe('run 55 tester: admin keys API with Vault unavailable (DEBT-410), real Vault', () => {
  let dir: string;
  let policy: string;
  let key: string;
  let token: string;
  let full: FullApp;
  let at = '';
  let fault: Fault = null;
  let offset = 0;
  const logs: string[] = [];
  const pino: string[] = [];

  const shim: typeof fetch = async (input, init) => {
    if (fault && fault.path.test(new URL(String(input)).pathname)) {
      if (fault.status === 'network') throw new TypeError('fetch failed');
      return new Response('{"errors":["injected"]}', { status: fault.status });
    }
    return fetch(input, init);
  };
  const ANY = new RegExp(`/v1/${MOUNT}/`);
  const META = new RegExp(`/v1/${MOUNT}/keys/[^/]+$`);
  const ROTATE = new RegExp(`/v1/${MOUNT}/keys/[^/]+/rotate$`);

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
    dir = await mkdtemp(join(tmpdir(), 'vg-r55t-'));
    const tokenFile = join(dir, 'token');
    await writeFile(tokenFile, token, { mode: 0o600 });

    const cfg = { addr: ADDR, tokenFile, mount: MOUNT, key, timeoutMs: 2000 };
    full = await bootFullApp({
      name: 'r55tv',
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
    // Fresh-login super_admin AT (aud=admin, auth_time now => step-up OK for rotate).
    const client = await seedFlowClient(full);
    const userId = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
    await full.conn
      .model('UserTenant')
      .updateOne(
        { userId: new Types.ObjectId(userId), tenantId: DEFAULT_TENANT_ID },
        { $set: { roles: ['super_admin'] } },
      );
    await seedConsent(full.conn, {
      userId,
      clientId: client.clientId,
      resource: FLOW_ADMIN_AUD,
      scopes: ADMIN_SCOPE.split(' '),
    });
    const verifier = randomBytes(32).toString('base64url');
    const code = await authorizeCode(full, {
      ...client,
      sessionId: (await full.app.get(SessionService).create(userId, DEFAULT_TENANT_ID)).id,
      resource: FLOW_ADMIN_AUD,
      scope: ADMIN_SCOPE,
      verifier,
    });
    const res = await formPost(full, '/token', client, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: FLOW_REDIRECT,
      code_verifier: verifier,
    });
    expect(res.statusCode).toBe(200);
    at = res.json<{ access_token: string }>().access_token;
  }, 60_000);

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

  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    full.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${at}`,
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    }) as Promise<InjectResponse>;

  /** The DEBT-410 window: the guard verified with a warm cache; it expires before `listKeys`. */
  function expireBetweenGuardAndController(status: number | 'network') {
    const svc = full.app.get(KeyRotationService);
    const original = svc.list.bind(svc);
    jest.spyOn(svc, 'list').mockImplementationOnce(() => {
      offset += 31_000; // metadata cache TTL is 30 s
      fault = { path: META, status };
      return original();
    });
  }

  const latestVersion = async () =>
    (await vault('GET', `${MOUNT}/keys/${key}`)).body.data.latest_version as number;

  it('V1 GET /admin/keys, cache expiring between guard and controller: network/429/503 => 503 + Retry-After 5 + no-store, no key data; 400/403 => 500; recovers', async () => {
    const ok = await call('GET', '/admin/keys');
    expect(ok.statusCode).toBe(200);

    for (const status of ['network', 429, 503] as const) {
      expireBetweenGuardAndController(status);
      const res = await call('GET', '/admin/keys');
      expect([status, res.statusCode]).toEqual([status, 503]);
      expect(res.headers['retry-after']).toBe('5');
      expect(String(res.headers['cache-control'])).toContain('no-store');
      expect(JSON.parse(res.body)).toEqual(OUTAGE);
      expect(res.body).not.toMatch(/kid|kty|vault|transit|127\.0\.0\.1|18200/i);
      expect(res.body).not.toContain(MOUNT);
      fault = null;
      expect((await call('GET', '/admin/keys')).statusCode).toBe(200); // refreshes the cache
    }
    for (const status of [400, 403] as const) {
      expireBetweenGuardAndController(status);
      const res = await call('GET', '/admin/keys');
      expect([status, res.statusCode]).toEqual([status, 500]);
      expect(res.headers['retry-after']).toBeUndefined();
      expect(res.json()).toMatchObject({ error: 'server_error' });
      expect(res.body).not.toContain(MOUNT);
      fault = null;
      expect((await call('GET', '/admin/keys')).statusCode).toBe(200);
    }
  });

  it('V2 GET /admin/keys with Vault fully down and the cache expired => 503 (fail-closed at the guard), never 200/401', async () => {
    offset += 31_000;
    fault = { path: ANY, status: 'network' };
    const res = await call('GET', '/admin/keys');
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(JSON.parse(res.body)).toEqual(OUTAGE);
    fault = null;
    expect((await call('GET', '/admin/keys')).statusCode).toBe(200);
  });

  it.each([
    ['all Vault paths (network)', () => ({ path: ANY, status: 'network' as const })],
    ['rotate call only (network)', () => ({ path: ROTATE, status: 'network' as const })],
    ['rotate call only (503)', () => ({ path: ROTATE, status: 503 })],
  ])(
    'V3 POST /admin/keys/rotate, Vault down on %s => 500 (not 503, no Retry-After) + audited failure; key version unchanged',
    async (_label, mkFault) => {
      expect((await call('GET', '/admin/keys')).statusCode).toBe(200); // warm cache for the guard
      const before = await latestVersion();
      const since = new Date();
      fault = mkFault();
      const res = await call('POST', '/admin/keys/rotate', { mode: 'normal' });
      fault = null;
      expect(res.statusCode).toBe(500);
      expect(res.headers['retry-after']).toBeUndefined();
      expect(res.json()).toMatchObject({ error: 'server_error' });
      expect(res.body).not.toContain(MOUNT);
      expect(await latestVersion()).toBe(before);
      const events = await full.conn
        .model('AuditLog')
        .find({ action: 'SIGNING_KEY_ROTATED', timestamp: { $gte: since } })
        .lean<Array<{ result: string; reason?: string }>>();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ result: 'failure', reason: 'rotate_failed' });
      expect(JSON.stringify(events)).not.toMatch(/hvs\./);
      expect(JSON.stringify(events)).not.toMatch(JWT);
    },
  );
});
