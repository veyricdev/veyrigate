import { jest } from '@jest/globals';
import { randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import IORedis from 'ioredis';
import { Types, type Model } from 'mongoose';
import { sha256 } from '../src/common/crypto/crypto.util';
import { deriveS256Challenge } from '../src/common/crypto/pkce.util';
import { ClientService } from '../src/modules/clients/client.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { TokenSigner } from '../src/modules/keys/token-signer';
import { ResourceService } from '../src/modules/resources/resource.service';
import { SESSION_COOKIE } from '../src/modules/sessions/session.cookie';
import { SessionService } from '../src/modules/sessions/session.service';
import {
  bootFullApp,
  FLOW_ADMIN_AUD,
  FLOW_API_AUD,
  FLOW_REDIRECT,
  formPost,
  seedFlowClient,
  type FullApp,
  type InjectResponse,
} from './full-app';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';
import { seedConsent, seedOAuthUser } from './oauth-fixtures';

/**
 * Run 81 tester, on the REAL app (`AppModule` + `configureApp`) over HTTP, adversarial cases on top
 * of the dev tests:
 * - T1 DEBT-413 (`idp_authz` browser binding of a login context): another browser's binding (also
 *   from another tenant's request) never resumes the victim's request and never burns it (the
 *   victim still gets HIS code afterwards, TTL not extended); hash-as-cookie confusion; Secure mode
 *   ignores a tossed bare `idp_authz`; odd/huge cookie values are a 400, never a 500; tabs share
 *   one cookie; replay after success; Max-Age refresh keeps the value (also through a resume that
 *   lands on login_required again); the binding (and its sha256) never reaches logs/audit/URL/body.
 * - T3 DEBT-323 (`expectedScopes`): hostile items => 400, order/case/dup mismatch => 409 with the
 *   exact fixed body (no scopes leak, no write, no audit); `[]` vs empty / absent field; N parallel
 *   PATCHes => exactly one 200; tenant_admin / stale super_admin / no-scope get the existing
 *   guard answer, never a 409/404 oracle.
 * - T2 DEBT-532: hostile identifiers on the format branches never echo.
 */
const MIN = 60_000;
const CONFLICT_BODY =
  '{"error":"conflict","error_description":"The resource was changed since it was read."}';
const BINDING = 'idp_authz';
const TENANT_B = 'r81t-tenant-b';

describe('run 81 tester: authz browser binding, expectedScopes, identifier echo', () => {
  let full: FullApp;
  let bff: { clientId: string; secret: string };
  let clientB: string;
  let redis: IORedis;
  let resourceModel: Model<Record<string, unknown>>;
  let auditModel: Model<Record<string, unknown>>;
  const ids = { superA: '', tenantA: '' };
  const pino: string[] = [];

  const boot = async (): Promise<void> => {
    full = await bootFullApp({
      name: 'run81t',
      logStream: new Writable({
        write(chunk, _e, cb) {
          pino.push(...String(chunk).split('\n').filter(Boolean));
          cb();
        },
      }),
    });
    redis = new IORedis(full.env.REDIS_URL, { maxRetriesPerRequest: 1 });
    resourceModel = full.conn.model<Record<string, unknown>>('Resource');
    auditModel = full.conn.model<Record<string, unknown>>('AuditLog');
    bff = await seedFlowClient(full);
    // A client of ANOTHER tenant on the same `api` resource (cross-tenant binding cases).
    clientB = `r81t-b-${randomUUID()}`;
    await full.app.get(ClientService).create({
      clientId: clientB,
      clientType: 'public',
      tokenEndpointAuthMethod: 'none',
      redirectUris: [FLOW_REDIRECT],
      allowedResources: ['api'],
      scopes: ['openid', 'api.read'],
      tenantId: TENANT_B,
    });
    ids.superA = await adminUser('super_admin');
    ids.tenantA = await adminUser('tenant_admin');
  };
  let setup: Promise<void> | undefined;
  beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await settled(setup);
    redis?.disconnect();
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);
  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function adminUser(role: string): Promise<string> {
    const userId = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
    await full.conn
      .model('UserTenant')
      .updateOne(
        { userId: new Types.ObjectId(userId), tenantId: DEFAULT_TENANT_ID },
        { $set: { roles: [role] } },
      );
    return userId;
  }

  // ------------------------------------------------------------------ T1 helpers

  const authorizeUrl = (clientId: string, challenge: string, extra: Record<string, string> = {}) =>
    `/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: FLOW_REDIRECT,
      scope: 'openid api.read',
      resource: FLOW_API_AUD,
      state: 'rp-state-r81',
      nonce: 'rp-nonce-r81',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...extra,
    }).toString()}`;

  type Started = {
    res: InjectResponse & { cookies: Array<Record<string, unknown>> };
    requestId: string;
    binding: string | undefined;
    set: Record<string, unknown> | undefined;
    verifier: string;
  };

  /** Fresh `/authorize` without a session => 302 /login, request_id + the Set-Cookie binding. */
  async function startLogin(
    clientId = bff.clientId,
    cookieHeader?: string,
    app = full.app,
  ): Promise<Started> {
    const verifier = randomBytes(32).toString('base64url');
    const res = (await app.inject({
      method: 'GET',
      url: authorizeUrl(clientId, deriveS256Challenge(verifier)),
      ...(cookieHeader !== undefined ? { headers: { cookie: cookieHeader } } : {}),
    })) as unknown as Started['res'];
    expect(res.statusCode).toBe(302);
    const location = String(res.headers['location']);
    expect(location.startsWith('/login?returnTo=')).toBe(true);
    const returnTo = decodeURIComponent(location.replace('/login?returnTo=', ''));
    const requestId = new URLSearchParams(returnTo.split('?')[1]).get('request_id')!;
    const set = res.cookies.find((c) => String(c.name).endsWith(BINDING));
    return { res, requestId, binding: set?.value as string | undefined, set, verifier };
  }

  /** A member of `tenantId` with a consent for both clients: a resume issues the code directly. */
  async function consentedSession(tenantIds: string[] = [DEFAULT_TENANT_ID]) {
    const userId = await seedOAuthUser(full.conn, { tenantId: tenantIds[0] });
    for (const t of tenantIds.slice(1)) {
      await full.conn
        .model('UserTenant')
        .create({ userId: new Types.ObjectId(userId), tenantId: t, status: 'active' });
    }
    for (const clientId of [bff.clientId, clientB]) {
      await seedConsent(full.conn, {
        userId,
        clientId,
        resource: FLOW_API_AUD,
        scopes: ['openid', 'api.read'],
      });
    }
    const sessionId = (await full.app.get(SessionService).create(userId, tenantIds[0])).id;
    return { userId, sessionId };
  }

  /** Resume with a raw Cookie header (so odd values reach the parser unmodified). */
  const resumeRaw = (requestId: string, cookieHeader: string, app = full.app) =>
    app.inject({
      method: 'GET',
      url: `/authorize?request_id=${encodeURIComponent(requestId)}`,
      headers: cookieHeader ? { cookie: cookieHeader } : {},
    }) as unknown as Promise<Started['res']>;

  const resume = (requestId: string, sessionId: string | undefined, binding?: string) =>
    resumeRaw(
      requestId,
      [
        sessionId !== undefined ? `${SESSION_COOKIE}=${sessionId}` : '',
        binding !== undefined ? `${BINDING}=${encodeURIComponent(binding)}` : '',
      ]
        .filter(Boolean)
        .join('; '),
    );

  const codeOf = (res: { headers: Record<string, unknown> }) => {
    const loc = String(res.headers['location'] ?? '');
    return loc.startsWith(FLOW_REDIRECT) ? new URL(loc).searchParams.get('code') : null;
  };
  const codeKeys = async () => (await redis.keys('authz_code:*')).length;
  const ctxKey = (rid: string) => `authz_ctx:${rid}`;

  /** The 400 "Request expired" page: no redirect, no RP state/redirect_uri, no binding Set-Cookie. */
  function expectExpired(res: Started['res'], label: unknown) {
    expect({ label, status: res.statusCode }).toEqual({ label, status: 400 });
    expect(res.headers['location']).toBeUndefined();
    expect(res.body).toContain('Request expired');
    expect(res.body).not.toContain('rp-state-r81');
    expect(res.body).not.toContain('app.example.com');
    expect(res.cookies.find((c) => String(c.name).endsWith(BINDING))).toBeUndefined();
  }

  const subOfCode = async (code: string, verifier: string): Promise<string> => {
    const tr = await formPost(full, '/token', bff, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: FLOW_REDIRECT,
      code_verifier: verifier,
    });
    expect(tr.statusCode).toBe(200);
    const idt = tr.json<{ id_token: string }>().id_token;
    return JSON.parse(Buffer.from(idt.split('.')[1], 'base64url').toString('utf8')).sub;
  };

  // ------------------------------------------------------------------ T1 DEBT-413

  describe('T1 DEBT-413: idp_authz browser binding', () => {
    it('C1 cross-browser + cross-tenant: an attacker binding (from his own tenant-B request), the hash-as-cookie and garbage never resume the victim request, never burn it, never extend its TTL; the victim then gets HIS code', async () => {
      const victimReq = await startLogin(bff.clientId);
      const attackerReq = await startLogin(clientB); // another browser, another tenant's client
      expect(attackerReq.binding).toBeTruthy();
      expect(attackerReq.binding).not.toBe(victimReq.binding);
      // The attacker is a fully valid member of the victim client's tenant (and of tenant B).
      const attacker = await consentedSession([DEFAULT_TENANT_ID, TENANT_B]);
      const codes0 = await codeKeys();
      const ttl0 = await redis.pttl(ctxKey(victimReq.requestId));
      expect(ttl0).toBeGreaterThan(0);

      const attempts: (string | undefined)[] = [
        attackerReq.binding,
        undefined,
        '',
        sha256(victimReq.binding!), // the stored hash itself, as the cookie
        JSON.parse((await redis.get(ctxKey(victimReq.requestId)))!).bindingHash,
        victimReq.binding!.toUpperCase(),
        `${victimReq.binding!} `.trim() + 'x',
        victimReq.binding!.slice(0, -1),
      ];
      for (const b of attempts) {
        expectExpired(await resume(victimReq.requestId, attacker.sessionId, b), b);
      }
      // The attacker's own request resumes fine with his own binding — the cookie is per-browser.
      expect(
        codeOf(await resume(attackerReq.requestId, attacker.sessionId, attackerReq.binding)),
      ).toBeTruthy();
      expect(await codeKeys()).toBe(codes0 + 1);
      // Victim context kept, TTL never extended by the failed attempts.
      expect(await redis.exists(ctxKey(victimReq.requestId))).toBe(1);
      expect(await redis.pttl(ctxKey(victimReq.requestId))).toBeLessThanOrEqual(ttl0);

      const victim = await consentedSession();
      const ok = await resume(victimReq.requestId, victim.sessionId, victimReq.binding);
      expect(ok.statusCode).toBe(302);
      const url = new URL(String(ok.headers['location']));
      expect(url.searchParams.get('state')).toBe('rp-state-r81');
      expect(await subOfCode(url.searchParams.get('code')!, victimReq.verifier)).toBe(
        victim.userId,
      );
    });

    it('C2 one browser, two tenants: the same cookie is reused for a tenant-A and a tenant-B request and both resume (binding is per browser, not per request)', async () => {
      const a = await startLogin(bff.clientId);
      const b = await startLogin(clientB, `${BINDING}=${a.binding}`);
      expect(b.binding).toBe(a.binding);
      const user = await consentedSession([DEFAULT_TENANT_ID, TENANT_B]);
      expect(codeOf(await resume(b.requestId, user.sessionId, a.binding))).toBeTruthy();
      expect(codeOf(await resume(a.requestId, user.sessionId, a.binding))).toBeTruthy();
    });

    it('C3 odd / huge cookie values on the resume => 400 expired page (never 500), context kept; the right value still resumes', async () => {
      const req = await startLogin();
      const user = await consentedSession();
      const odd = [
        'a',
        '%',
        '%zz',
        '%00',
        '%E2%80%AE',
        '%C3%A9',
        '"quoted"',
        '\\x00',
        '..%2F..%2F',
        '<script>alert(1)</script>',
        'a=b=c',
        '$(id)',
        '%'.repeat(64),
        'x'.repeat(4096),
        `${req.binding}${'x'.repeat(4000)}`,
      ];
      for (const v of odd) {
        const res = await resumeRaw(
          req.requestId,
          `${SESSION_COOKIE}=${user.sessionId}; ${BINDING}=${v}`,
        );
        expectExpired(res, v.slice(0, 40));
      }
      // Duplicate cookie names: a foreign value FIRST, the right value second.
      const dup = await resumeRaw(
        req.requestId,
        `${SESSION_COOKIE}=${user.sessionId}; ${BINDING}=${'y'.repeat(43)}; ${BINDING}=${req.binding}`,
      );
      // @fastify/cookie keeps the first value: the foreign one => refused, context kept.
      expectExpired(dup, 'duplicate name, foreign first');
      expect(await redis.exists(ctxKey(req.requestId))).toBe(1);
      expect(codeOf(await resume(req.requestId, user.sessionId, req.binding))).toBeTruthy();
    });

    it('C3b odd cookie values on a FRESH /authorize => 302 /login (never 500) with a binding the next resume accepts', async () => {
      const user = await consentedSession();
      for (const v of ['%zz', '%00', '"q"', 'x'.repeat(4096)]) {
        const req = await startLogin(bff.clientId, `${BINDING}=${v}`);
        expect(req.binding).toBeTruthy();
        // Whatever the server kept, the browser sends back what it was given.
        const ok = await resume(req.requestId, user.sessionId, req.binding);
        expect({ v: v.slice(0, 10), code: Boolean(codeOf(ok)) }).toEqual({
          v: v.slice(0, 10),
          code: true,
        });
      }
    });

    it('C4 three tabs share one cookie, resumed in reverse order => three codes, every Set-Cookie the same value with Max-Age=600', async () => {
      const t1 = await startLogin();
      const jar = `${BINDING}=${t1.binding}`;
      const t2 = await startLogin(bff.clientId, jar);
      const t3 = await startLogin(bff.clientId, jar);
      for (const t of [t2, t3]) {
        expect(t.binding).toBe(t1.binding);
        expect(t.set).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 600 });
      }
      const user = await consentedSession();
      for (const t of [t3, t2, t1]) {
        expect(codeOf(await resume(t.requestId, user.sessionId, t1.binding))).toBeTruthy();
      }
    });

    it('C5 replay: after a successful resume the same request_id + cookie (+ same or other session) => 400, no second code', async () => {
      const req = await startLogin();
      const user = await consentedSession();
      expect(codeOf(await resume(req.requestId, user.sessionId, req.binding))).toBeTruthy();
      const codes = await codeKeys();
      expectExpired(await resume(req.requestId, user.sessionId, req.binding), 'replay same');
      const other = await consentedSession();
      expectExpired(await resume(req.requestId, other.sessionId, req.binding), 'replay other');
      expect(await codeKeys()).toBe(codes);
    });

    it('C6 Max-Age refresh keeps the value: a resume WITHOUT a session (right cookie) lands on login_required again, re-sets the SAME value, and the new request_id is bound to the same hash', async () => {
      const req = await startLogin();
      const again = await resume(req.requestId, undefined, req.binding);
      expect(again.statusCode).toBe(302);
      expect(String(again.headers['location'])).toMatch(/^\/login\?returnTo=/);
      const set = again.cookies.find((c) => String(c.name).endsWith(BINDING));
      expect(set).toMatchObject({ value: req.binding, maxAge: 600, httpOnly: true, path: '/' });
      const rid2 = new URLSearchParams(
        decodeURIComponent(String(again.headers['location']).replace('/login?returnTo=', '')).split(
          '?',
        )[1],
      ).get('request_id')!;
      expect(rid2).not.toBe(req.requestId);
      expect(JSON.parse((await redis.get(ctxKey(rid2)))!).bindingHash).toBe(sha256(req.binding!));
      const user = await consentedSession();
      expect(codeOf(await resume(rid2, user.sessionId, req.binding))).toBeTruthy();
    });

    it('C7 exposure: the binding value and its sha256 never appear in the pino log, the audit collection, a Location or a body', async () => {
      const from = pino.length;
      const audit0 = await auditModel.countDocuments({});
      const req = await startLogin();
      const attacker = await consentedSession();
      const fail = await resume(req.requestId, attacker.sessionId, 'x'.repeat(43));
      const victim = await consentedSession();
      const ok = await resume(req.requestId, victim.sessionId, req.binding);
      expect(codeOf(ok)).toBeTruthy();
      expect(await auditModel.countDocuments({})).toBeGreaterThan(audit0);
      const secrets = [req.binding!, sha256(req.binding!)];
      const lines = pino.slice(from);
      expect(lines.length).toBeGreaterThan(0);
      const audits = JSON.stringify(await auditModel.find({}).lean());
      for (const s of secrets) {
        for (const l of lines) expect(l).not.toContain(s);
        expect(audits).not.toContain(s);
        for (const r of [req.res, fail, ok]) {
          expect(String(r.headers['location'] ?? '')).not.toContain(s);
          expect(r.body).not.toContain(s);
        }
      }
    });

    it('C8 Secure mode: only __Host-idp_authz is set and read; a tossed bare idp_authz (even with the right value) is ignored on resume and never reused on a fresh request', async () => {
      const sec = await bootFullApp({ name: 'run81t-sec', env: { SESSION_COOKIE_SECURE: 'true' } });
      try {
        const flow = await seedFlowClient(sec);
        const verifier = randomBytes(32).toString('base64url');
        const fresh = (await sec.app.inject({
          method: 'GET',
          url: authorizeUrl(flow.clientId, deriveS256Challenge(verifier)),
          headers: { cookie: `${BINDING}=tossed-by-a-subdomain-value-xxxxxxxxxxxxxxxx` },
        })) as unknown as Started['res'];
        expect(fresh.statusCode).toBe(302);
        expect(fresh.cookies.find((c) => c.name === BINDING)).toBeUndefined();
        const host = fresh.cookies.find((c) => c.name === `__Host-${BINDING}`)!;
        expect(host).toMatchObject({ secure: true, httpOnly: true, path: '/', maxAge: 600 });
        expect(host.domain).toBeUndefined();
        expect(host.value).not.toBe('tossed-by-a-subdomain-value-xxxxxxxxxxxxxxxx');
        const binding = String(host.value);
        const rid = new URLSearchParams(
          decodeURIComponent(
            String(fresh.headers['location']).replace('/login?returnTo=', ''),
          ).split('?')[1],
        ).get('request_id')!;

        const userId = await seedOAuthUser(sec.conn, { tenantId: DEFAULT_TENANT_ID });
        await seedConsent(sec.conn, {
          userId,
          clientId: flow.clientId,
          resource: FLOW_API_AUD,
          scopes: ['openid', 'api.read'],
        });
        const sid = (await sec.app.get(SessionService).create(userId, DEFAULT_TENANT_ID)).id;
        const sess = `__Host-${SESSION_COOKIE}=${sid}`;
        for (const c of [
          `${sess}; ${BINDING}=${binding}`,
          `${sess}; ${BINDING}=${binding}; __Host-${BINDING}=${'z'.repeat(43)}`,
          `${sess}; __Host-${BINDING}=${'z'.repeat(43)}; ${BINDING}=${binding}`,
        ]) {
          const res = await resumeRaw(rid, c, sec.app);
          expectExpired(res, c.replace(sid, 'SID').replace(binding, 'B'));
        }
        const ok = await resumeRaw(rid, `${sess}; __Host-${BINDING}=${binding}`, sec.app);
        expect(codeOf(ok)).toBeTruthy();
      } finally {
        await sec.close();
      }
    });
  });

  // ------------------------------------------------------------------ T3 DEBT-323

  /** Admin AT as `/token` mints it (aud=admin, sid, auth_time), signed by the app's own key. */
  const tok = (sub: string, authAgoMs = 0, scope = 'openid admin.read admin.write') =>
    full.app.get(TokenSigner).sign(
      {
        scope,
        client_id: bff.clientId,
        sid: randomBytes(32).toString('hex'),
        auth_time: Math.floor((Date.now() - authAgoMs) / 1000),
      },
      { audience: FLOW_ADMIN_AUD, subject: sub, expiresInSec: 900, typ: 'at+jwt' },
    );

  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, token: string, payload?: unknown) =>
    full.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    }) as Promise<InjectResponse>;

  describe('T3 DEBT-323: PATCH /admin/resources/:id expectedScopes', () => {
    const STORED = ['r81.read', 'r81.write'];
    const mkResource = async (scopes: string[] | null | 'unset' = STORED) => {
      const resourceId = `r81t-${randomUUID().slice(0, 8)}`;
      await full.app.get(ResourceService).create({
        resourceId,
        identifier: `https://${resourceId}.example.com/`,
        scopes: Array.isArray(scopes) ? scopes : [],
      });
      if (scopes === 'unset')
        await resourceModel.updateOne({ resourceId }, { $unset: { scopes: 1 } });
      if (scopes === null)
        await resourceModel.updateOne({ resourceId }, { $set: { scopes: null } });
      return resourceId;
    };
    const stored = async (resourceId: string) =>
      (await resourceModel.findOne({ resourceId }).lean())?.scopes;
    const audits = (resourceId: string) =>
      auditModel.countDocuments({ action: 'ADMIN_RESOURCE_UPDATED', targetId: resourceId });
    const patch = async (resourceId: string, body: unknown, token?: string) =>
      call('PATCH', `/admin/resources/${resourceId}`, token ?? (await tok(ids.superA)), body);

    it.each([
      ['leading space', [' r81.read', 'r81.write']],
      ['inner space', ['r81 .read']],
      ['NBSP', ['r81.read ']],
      ['U+3000', ['　']],
      ['U+2028', ['r81.read ']],
      ['LF', ['r81.read\n']],
      ['tab', ['r81.\tread']],
      ['BOM U+FEFF', ['﻿r81.read']],
      ['empty string', ['']],
      ['number item', [1]],
      ['null item', [null]],
      ['nested array', [['r81.read']]],
      ['object item', [{ $ne: 1 }]],
      ['257-char item', ['x'.repeat(257)]],
      ['51 items', Array.from({ length: 51 }, (_, i) => `s${i}`)],
      ['string instead of array', 'r81.read'],
      ['null', null],
      ['operator object', { $exists: true }],
    ])('expectedScopes %s => 400 invalid_request, nothing written, no audit', async (_l, exp) => {
      const id = await mkResource();
      const res = await patch(id, { scopes: ['new.one'], expectedScopes: exp });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_request');
      expect(await stored(id)).toEqual(STORED);
      expect(await audits(id)).toBe(0);
    });

    it.each([
      ['order', ['r81.write', 'r81.read']],
      ['subset', ['r81.read']],
      ['superset', ['r81.read', 'r81.write', 'r81.admin']],
      ['duplicate', ['r81.read', 'r81.read', 'r81.write']],
      ['case', ['R81.read', 'r81.write']],
      ['zero-width (passes SCOPE_TOKEN)', ['r81.read​', 'r81.write']],
      ['[] vs non-empty', []],
    ])(
      '%s mismatch => 409 with exactly the fixed body, no scopes leak, nothing written, no audit',
      async (_l, exp) => {
        const id = await mkResource();
        const res = await patch(id, { scopes: ['new.one'], expectedScopes: exp });
        expect(res.statusCode).toBe(409);
        expect(res.body).toBe(CONFLICT_BODY);
        expect(res.headers['cache-control']).toBe('no-store');
        for (const s of [...STORED, 'r81', id, 'new.one']) expect(res.body).not.toContain(s);
        expect(await stored(id)).toEqual(STORED);
        expect(await audits(id)).toBe(0);
      },
    );

    it('[] matches an empty array and an absent field (200 + 1 audit each)', async () => {
      for (const kind of [[], 'unset'] as const) {
        const id = await mkResource(kind as string[] | 'unset');
        const res = await patch(id, { scopes: ['x.read'], expectedScopes: [] });
        expect({ kind, status: res.statusCode }).toEqual({ kind, status: 200 });
        expect(await stored(id)).toEqual(['x.read']);
        expect(await audits(id)).toBe(1);
      }
    });

    it('exact match (stored order) => 200; then the stale value => 409; without expectedScopes => last write wins', async () => {
      const id = await mkResource();
      expect((await patch(id, { scopes: ['a.1'], expectedScopes: STORED })).statusCode).toBe(200);
      expect((await patch(id, { scopes: ['a.2'], expectedScopes: STORED })).body).toBe(
        CONFLICT_BODY,
      );
      expect((await patch(id, { scopes: ['a.3'] })).statusCode).toBe(200);
      expect(await stored(id)).toEqual(['a.3']);
      expect(await audits(id)).toBe(2);
    });

    it('N=12 parallel PATCHes with the same expectedScopes => exactly one 200, eleven 409, DB = the winner, one audit', async () => {
      const id = await mkResource();
      const t = await tok(ids.superA);
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          patch(id, { scopes: [`w.${i}`], expectedScopes: STORED }, t),
        ),
      );
      const ok = results.filter((r) => r.statusCode === 200);
      expect(ok).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 409)).toHaveLength(11);
      for (const r of results.filter((x) => x.statusCode === 409))
        expect(r.body).toBe(CONFLICT_BODY);
      expect(await stored(id)).toEqual(ok[0].json().scopes);
      expect(await audits(id)).toBe(1);
    });

    it('role / step-up / scope matrix: the existing guard answer comes first, never a 409 or 404 oracle', async () => {
      const id = await mkResource();
      const missing = `r81t-missing-${randomUUID().slice(0, 8)}`;
      const bodies = [
        { scopes: ['z.1'], expectedScopes: STORED }, // would succeed
        { scopes: ['z.1'], expectedScopes: ['nope'] }, // would 409
      ];
      const taFresh = await tok(ids.tenantA);
      const taStale = await tok(ids.tenantA, 6 * MIN);
      const answers: string[] = [];
      for (const rid of [id, missing]) {
        for (const body of bodies) {
          for (const t of [taFresh, taStale]) {
            const res = await patch(rid, body, t);
            expect(res.statusCode).toBe(403);
            expect(res.json()).toEqual({ error: 'forbidden' });
            answers.push(res.body);
          }
          const stale = await patch(rid, body, await tok(ids.superA, 6 * MIN));
          expect(stale.statusCode).toBe(403);
          expect(stale.json().error).toBe('step_up_required');
          const noScope = await patch(rid, body, await tok(ids.superA, 0, 'openid admin.read'));
          expect(noScope.statusCode).toBe(403);
          expect(noScope.json().error).toBe('insufficient_scope');
        }
      }
      expect(new Set(answers).size).toBe(1);
      expect(await stored(id)).toEqual(STORED);
      expect(await audits(id)).toBe(0);
      // super_admin fresh: missing => 404 (not 409), present + wrong => 409.
      expect((await patch(missing, bodies[1])).statusCode).toBe(404);
      expect((await patch(id, bodies[1])).statusCode).toBe(409);
      expect((await patch(id, bodies[0])).statusCode).toBe(200);
    });
  });

  // ------------------------------------------------------------------ T2 DEBT-532

  describe('T2 DEBT-532: hostile identifiers on the format branches never echo', () => {
    it.each([
      ['not absolute + html', 'MARK<svg/onload=alert(1)>', 'resource must be an absolute URI'],
      ['relative path', '/MARK/../../etc/passwd', 'resource must be an absolute URI'],
      ['scheme-less host', '//MARK.example.com/', 'resource must be an absolute URI'],
      ['percent junk', '%MARK%zz', 'resource must be an absolute URI'],
      [
        'fragment html',
        'https://a.example/#MARK<svg/onload=alert(1)>',
        'resource must not contain a fragment',
      ],
      [
        'fragment encoded',
        'https://a.example/x#%3Cscript%3EMARK',
        'resource must not contain a fragment',
      ],
      ['urn fragment', 'urn:MARK:x#y', 'resource must not contain a fragment'],
      ['long', `MARK${'A'.repeat(1500)}`, 'resource must be an absolute URI'],
    ])(
      '%s => 400 with the fixed message only, no document, no audit, no echo in logs',
      async (_l, identifier, message) => {
        const from = pino.length;
        const resourceId = `r81t-t2-${randomUUID().slice(0, 8)}`;
        const audit0 = await auditModel.countDocuments({ action: 'ADMIN_RESOURCE_CREATED' });
        const res = await call('POST', '/admin/resources', await tok(ids.superA), {
          resourceId,
          identifier,
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: 'invalid_request', error_description: message });
        for (const piece of ['MARK', 'svg', 'alert', 'passwd', '%3Cscript']) {
          expect(res.body).not.toContain(piece);
          for (const l of pino.slice(from)) expect(l).not.toContain(piece);
        }
        expect(await resourceModel.countDocuments({ resourceId })).toBe(0);
        expect(await auditModel.countDocuments({ action: 'ADMIN_RESOURCE_CREATED' })).toBe(audit0);
      },
    );
  });
});
