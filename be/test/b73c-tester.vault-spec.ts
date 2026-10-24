import { jest } from '@jest/globals';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, connect, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { SESSION_COOKIE } from '../src/modules/sessions/session.cookie';
import { SessionService } from '../src/modules/sessions/session.service';
import { CsrfService } from '../src/modules/ui/csrf.service';
import {
  authorizeCode,
  bootFullApp,
  FLOW_ADMIN_AUD,
  FLOW_API_AUD,
  FLOW_REDIRECT,
  formPost,
  seedFlowClient,
  type FullApp,
} from './full-app';
import { seedConsent, seedOAuthUser } from './oauth-fixtures';

/**
 * Tester, run 53c (DEBT-394) against a REAL Vault cut by a TCP proxy (not a mocked provider):
 * after the 30 s key cache expires with Vault unreachable —
 * - admin API (real `aud=admin` token, read + @RequireRecentAuth write), /userinfo, /introspect
 *   ⇒ 503 temporarily_unavailable + Retry-After 5 + no-store, never 401 / active:false;
 * - a malformed token is still 401 / active:false / admin 401 (judged without keys);
 * - POST /logout with a VALID id_token_hint + REGISTERED post_logout_redirect_uri ⇒ only the default
 *   redirect (the hint cannot be verified ⇒ no RP redirect, so no open redirect), session ended;
 * - Vault back ⇒ everything recovers.
 */
const ADDR = process.env.VAULT_TEST_ADDR!;
const ROOT = process.env.VAULT_TEST_ROOT_TOKEN!;
const VAULT_URL = new URL(ADDR);
const MOUNT = `vg-b73ct-${randomBytes(4).toString('hex')}`;
const POST_LOGOUT = 'https://app.example.com/after-logout';
const ADMIN_SCOPE = 'openid admin.read admin.write';

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

describe('run 53c tester: real Vault down ⇒ admin/userinfo/introspect 503, logout no open redirect', () => {
  let dir: string;
  const policies: string[] = [];
  const realNow = Date.now.bind(Date);
  let offset = 0;

  beforeAll(async () => {
    expect((await vault('POST', `sys/mounts/${MOUNT}`, { type: 'transit' })).status).toBe(204);
    dir = await mkdtemp(join(tmpdir(), 'vg-b73ct-'));
  });
  afterAll(async () => {
    for (const p of policies) await vault('DELETE', `sys/policies/acl/${p}`);
    await vault('DELETE', `sys/mounts/${MOUNT}`);
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    offset = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
  });
  afterEach(() => jest.restoreAllMocks());

  it('V-real: cache expired + Vault cut ⇒ 503 everywhere a key is needed; malformed 401; logout default redirect; recovers', async () => {
    const key = `k-${randomUUID()}`;
    expect(
      (await vault('POST', `${MOUNT}/keys/${key}`, { type: 'rsa-2048', exportable: false })).status,
    ).toBeLessThan(300);
    const hcl = (
      await readFile(join(process.cwd(), '..', 'ops', 'vault', 'idp-signer.hcl'), 'utf8')
    )
      .replaceAll('<mount>', MOUNT)
      .replaceAll('<key>', key);
    const policy = `p-${key}`;
    expect((await vault('PUT', `sys/policies/acl/${policy}`, { policy: hcl })).status).toBe(204);
    policies.push(policy);
    const tok = await vault('POST', 'auth/token/create', {
      policies: [policy],
      no_default_policy: true,
      ttl: '15m',
    });
    const tokenFile = join(dir, `${key}.token`);
    await writeFile(tokenFile, tok.body.auth.client_token as string, { mode: 0o600 });

    const proxy = new CuttableProxy();
    await proxy.up();
    const full: FullApp = await bootFullApp({
      name: 'b73ct',
      env: {
        KEY_PROVIDER: 'vault',
        VAULT_ADDR: `http://127.0.0.1:${proxy.port}`,
        VAULT_TOKEN_FILE: tokenFile,
        VAULT_TRANSIT_MOUNT: MOUNT,
        VAULT_TRANSIT_KEY: key,
      },
    });
    try {
      const client = await seedFlowClient(full);
      await full.conn
        .model('Client')
        .updateOne(
          { clientId: client.clientId },
          { $set: { postLogoutRedirectUris: [POST_LOGOUT] } },
        );
      const userId = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
      await full.conn
        .model('UserTenant')
        .updateOne({ tenantId: DEFAULT_TENANT_ID, userId }, { $set: { roles: ['tenant_admin'] } });
      await seedConsent(full.conn, {
        userId,
        clientId: client.clientId,
        resource: FLOW_API_AUD,
        scopes: ['openid', 'api.read'],
      });
      await seedConsent(full.conn, {
        userId,
        clientId: client.clientId,
        resource: FLOW_ADMIN_AUD,
        scopes: ADMIN_SCOPE.split(' '),
      });
      const sessionId = (await full.app.get(SessionService).create(userId, DEFAULT_TENANT_ID)).id;
      const issue = async (resource: string, scope: string) => {
        const verifier = randomBytes(32).toString('base64url');
        const code = await authorizeCode(full, {
          ...client,
          sessionId,
          resource,
          scope,
          verifier,
        });
        const res = await formPost(full, '/token', client, {
          grant_type: 'authorization_code',
          code,
          redirect_uri: FLOW_REDIRECT,
          code_verifier: verifier,
        });
        expect(res.statusCode).toBe(200);
        return res.json<{ access_token: string; id_token: string }>();
      };
      const api = await issue(FLOW_API_AUD, 'openid api.read');
      const admin = await issue(FLOW_ADMIN_AUD, ADMIN_SCOPE);
      const adminGet = (bearer: string) =>
        full.app.inject({
          method: 'GET',
          url: '/admin/tenants',
          headers: { authorization: `Bearer ${bearer}` },
        });
      expect((await adminGet(admin.access_token)).statusCode).toBe(200);

      await proxy.down();
      offset += 31_000; // key cache expired, Vault unreachable

      const outage = [
        ['GET /admin/tenants', await adminGet(admin.access_token)],
        [
          'POST /admin/clients',
          await full.app.inject({
            method: 'POST',
            url: '/admin/clients',
            headers: {
              authorization: `Bearer ${admin.access_token}`,
              'content-type': 'application/json',
            },
            payload: '{}',
          }),
        ],
        [
          'GET /userinfo',
          await full.app.inject({
            method: 'GET',
            url: '/userinfo',
            headers: { authorization: `Bearer ${api.access_token}` },
          }),
        ],
        [
          'POST /introspect',
          await formPost(full, '/introspect', client, { token: api.access_token }),
        ],
      ] as const;
      for (const [name, res] of outage) {
        expect([
          name,
          res.statusCode,
          res.headers['retry-after'],
          String(res.headers['cache-control']).includes('no-store'),
          res.headers['set-cookie'],
          'active' in res.json(),
          res.json().error,
        ]).toEqual([name, 503, '5', true, undefined, false, 'temporarily_unavailable']);
      }
      // Malformed tokens are judged without keys.
      expect((await adminGet('not-a-jwt')).statusCode).toBe(401);
      const badUi = await full.app.inject({
        method: 'GET',
        url: '/userinfo',
        headers: { authorization: 'Bearer a.b.c' },
      });
      expect(badUi.statusCode).toBe(401);
      expect((await formPost(full, '/introspect', client, { token: 'not-a-jwt' })).json()).toEqual({
        active: false,
      });

      // Logout with a valid hint + registered target: hint unverifiable ⇒ default redirect only.
      const csrf = full.app.get(CsrfService);
      const out = await full.app.inject({
        method: 'POST',
        url: '/logout',
        cookies: { [SESSION_COOKIE]: sessionId },
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          _csrf: csrf.token(sessionId),
          id_token_hint: api.id_token,
          post_logout_redirect_uri: POST_LOGOUT,
          state: 'st',
        }).toString(),
      });
      expect(out.statusCode).toBe(302);
      expect(out.headers['location']).toBe('/login?loggedOut=1');
      expect(await full.app.get(SessionService).get(sessionId)).toBeNull();

      await proxy.up(); // same port
      const back = await full.app.inject({
        method: 'GET',
        url: '/userinfo',
        headers: { authorization: `Bearer ${api.access_token}` },
      });
      expect(back.statusCode).toBe(401); // keys back; the session was ended by the logout above
      expect(back.json()).toMatchObject({ error: 'invalid_token' });
    } finally {
      await full.close();
      await proxy.down().catch(() => undefined);
    }
  }, 120_000);
});
