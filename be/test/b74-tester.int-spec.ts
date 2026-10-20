import { jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { buildCsp } from '../src/common/http/csp';
import { ClientService } from '../src/modules/clients/client.service';
import { FED_BINDING_COOKIE } from '../src/modules/federation/federation.controller';
import { FederationStateStore } from '../src/modules/federation/federation-state.store';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { SessionService } from '../src/modules/sessions/session.service';
import { Types } from 'mongoose';
import {
  authorizeCode,
  bootFullApp,
  FLOW_ADMIN_AUD,
  FLOW_API_AUD,
  FLOW_REDIRECT,
  formPost,
  seedFlowClient,
  type FullApp,
  type InjectResponse,
} from './full-app';
import { seedConsent, seedOAuthUser } from './oauth-fixtures';

/**
 * Tester cross-checks for run 38 (B7.4), beyond the dev specs:
 * - static: unicode/overlong/double-encoded/`//`/`/assets/../`/absolute-path variants + symlink;
 * - headers on HtmlExceptionFilter error pages (DEBT-233 confirmation);
 * - log capture on federation callback failures and more admin 500 shapes.
 */
const METRICS_TOKEN = randomBytes(32).toString('hex');
const GOOGLE_SECRET = `gsecret-${randomBytes(12).toString('hex')}`;

describe('B7.4 tester cross-checks', () => {
  let full: FullApp;
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(...String(chunk).split('\n').filter(Boolean));
      cb();
    },
  });
  let client: { clientId: string; secret: string };
  let adminToken = '';

  beforeAll(async () => {
    full = await bootFullApp({
      name: 'tester38',
      env: {
        METRICS_TOKEN,
        GOOGLE_CLIENT_ID: 'tester-google-client.apps.example',
        GOOGLE_CLIENT_SECRET: GOOGLE_SECRET,
      },
      logStream: stream,
    });
    client = await seedFlowClient(full);
    const userId = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
    await full.conn
      .model('UserTenant')
      .updateOne(
        { userId: new Types.ObjectId(userId), tenantId: DEFAULT_TENANT_ID },
        { $set: { roles: ['tenant_admin'] } },
      );
    await seedConsent(full.conn, {
      userId,
      clientId: client.clientId,
      resource: FLOW_ADMIN_AUD,
      scopes: ['openid', 'admin.read'],
    });
    const sessionId = (await full.app.get(SessionService).create(userId, DEFAULT_TENANT_ID)).id;
    const verifier = randomBytes(32).toString('base64url');
    const code = await authorizeCode(full, {
      ...client,
      sessionId,
      resource: FLOW_ADMIN_AUD,
      scope: 'openid admin.read',
      verifier,
    });
    adminToken = (
      await formPost(full, '/token', client, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: FLOW_REDIRECT,
        code_verifier: verifier,
      })
    ).json<{ access_token: string }>().access_token;
    expect(adminToken).toBeTruthy();
  }, 90_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    if (full) await full.close();
  });

  afterEach(() => jest.restoreAllMocks());

  const get = (url: string, headers: Record<string, string> = {}) =>
    full.app.inject({ method: 'GET', url, headers });

  // ------------------------------------------------------------------ static traversal
  describe('static /assets traversal variants', () => {
    const publicDir = join(process.cwd(), 'src', 'public');
    let outside = '';
    let styles = '';
    const markers = ['"@sso-idp/be"', 'for 16-bit app support', '[fonts]', 'root:x:0:0'];

    beforeAll(async () => {
      outside = (await readFile(join(publicDir, '..', 'app.module.ts'), 'utf8')).slice(0, 40);
      styles = await readFile(join(publicDir, 'styles.css'), 'utf8');
    });

    const assertNotOutside = (res: InjectResponse) => {
      expect(res.body).not.toContain(outside);
      for (const m of markers) expect(res.body).not.toContain(m);
      if (res.statusCode === 200) expect(res.body).toBe(styles); // only ever the real asset
    };

    it.each([
      // overlong UTF-8 / unicode dot forms
      '/assets/%c0%ae%c0%ae/app.module.ts',
      '/assets/%c0%ae%c0%ae%c0%afapp.module.ts',
      '/assets/%e0%80%ae%e0%80%ae/app.module.ts',
      '/assets/%u002e%u002e/app.module.ts',
      '/assets/%ef%bc%8e%ef%bc%8e/app.module.ts',
      '/assets/%e2%80%a5/app.module.ts',
      // double / mixed encoding
      '/assets/%252e%252e/app.module.ts',
      '/assets/%252e%252e%252fapp.module.ts',
      '/assets/.%2e/app.module.ts',
      '/assets/%2e./app.module.ts',
      '/assets/..%252fapp.module.ts',
      // `//` and dot-segment forms
      '/assets//../app.module.ts',
      '/assets//..//app.module.ts',
      '//assets/../app.module.ts',
      '/assets/../assets/../app.module.ts',
      '/assets/styles.css/../../app.module.ts',
      '/assets/....//app.module.ts',
      '/assets/..;/app.module.ts',
      '/assets/%00../app.module.ts',
      '/assets/..%00/app.module.ts',
      // absolute paths
      '/assets/%2fetc%2fpasswd',
      '/assets//etc/passwd',
      '/assets/C:/Windows/win.ini',
      '/assets/C%3a%5cWindows%5cwin.ini',
      '/assets/%5c%5c127.0.0.1%5cc$%5cWindows%5cwin.ini',
      '/assets/../../package.json',
      '/assets/%2e%2e%5c%2e%2e%5cpackage.json',
    ])('%s never serves a file outside public/', async (url) => {
      const res = await get(url);
      assertNotOutside(res);
      // a forbidden/non-canonical path is a client error (403/404), never a 5xx
      expect(res.statusCode).toBeLessThan(500);
    });

    it.each(['/assets/../assets/styles.css', '//assets/styles.css', '/assets//styles.css'])(
      '%s: normalised form only ever yields styles.css or a 4xx',
      async (url) => {
        const res = await get(url);
        assertNotOutside(res);
        expect(res.statusCode).toBeLessThan(500);
      },
    );

    it('symlink inside public/ pointing outside (record behaviour; skip if OS refuses)', async () => {
      const name = `vg-link-${process.pid}-${Date.now()}.txt`;
      const link = join(publicDir, name);
      try {
        await symlink(join(publicDir, '..', 'app.module.ts'), link, 'file');
      } catch (e) {
        // Windows without Developer Mode/admin: EPERM. Documented in the report.
        console.warn(`symlink not created: ${(e as NodeJS.ErrnoException).code}`);
        return;
      }
      try {
        const res = await get(`/assets/${name}`);
        console.warn(`symlink served status=${res.statusCode}`);
        // A planted symlink needs write access to public/ (outside the HTTP threat model);
        // the behaviour is recorded, not asserted.
      } finally {
        await rm(link, { force: true });
      }
    });
  });

  // ------------------------------------------------------------------ HTML error headers
  describe('headers on HtmlExceptionFilter error pages', () => {
    const baseHeaders = (res: InjectResponse) => {
      const h = (n: string) => res.headers[n];
      expect(h('x-content-type-options')).toBe('nosniff');
      expect(h('referrer-policy')).toBe('no-referrer');
      expect(String(h('x-frame-options') ?? '')).toMatch(/^(DENY|SAMEORIGIN)$/);
      const m = /max-age=(\d+)/.exec(String(h('strict-transport-security') ?? ''));
      expect(Number(m?.[1] ?? 0)).toBeGreaterThanOrEqual(15552000);
      const csp = String(h('content-security-policy') ?? '');
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
      expect(h('x-powered-by')).toBeUndefined();
      expect(String(h('server') ?? '')).not.toMatch(/\d/);
      expect(String(h('content-type') ?? '')).toMatch(/^text\/html/);
    };

    const loginNoCsrf = () =>
      full.app.inject({
        method: 'POST',
        url: '/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'email=a%40b.c&password=x',
      });

    it('POST /login without CSRF => 403 HTML with base security headers + CSP === buildCsp()', async () => {
      const res = await loginNoCsrf();
      expect(res.statusCode).toBe(403);
      baseHeaders(res);
      expect(res.headers['content-security-policy']).toBe(buildCsp());
    });

    // DEBT-233 (fixed in run 38 retry 1): HTML error pages are never cached.
    it('DEBT-233: POST /login 403 HTML error page carries Cache-Control no-store', async () => {
      const res = await loginNoCsrf();
      expect(String(res.headers['cache-control'] ?? '')).toMatch(/\bno-store\b/);
    });

    it('GET /authorize 500 (dependency failure) => HTML with base security headers', async () => {
      jest
        .spyOn(ClientService.prototype, 'findByClientId')
        .mockRejectedValueOnce(new Error('forced'));
      const res = await get(
        `/authorize?${new URLSearchParams({
          response_type: 'code',
          client_id: client.clientId,
          redirect_uri: FLOW_REDIRECT,
          scope: 'openid',
          code_challenge: 'x'.repeat(43),
          code_challenge_method: 'S256',
        }).toString()}`,
      );
      expect(res.statusCode).toBe(500);
      baseHeaders(res);
      console.warn(`authorize 500 cache-control=${String(res.headers['cache-control'])}`);
    });
  });

  // ------------------------------------------------------------------ log capture
  describe('log capture: federation callback failures + admin 500 shapes', () => {
    const secrets = new Map<string, string>();
    const keep = (label: string, v: string) => {
      secrets.set(label, v);
      return v;
    };
    let requestId = '';

    async function startLeg(): Promise<{ state: string; binding: string }> {
      const res = await get(`/auth/google/start?request_id=${encodeURIComponent(requestId)}`);
      expect(res.statusCode).toBe(302);
      const loc = new URL(String(res.headers['location']));
      const state = loc.searchParams.get('state') ?? '';
      const raw = res.headers['set-cookie'];
      const all = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
      const c = all.find((x) => x.startsWith(`${FED_BINDING_COOKIE}=`)) ?? '';
      const binding = decodeURIComponent(c.slice(FED_BINDING_COOKIE.length + 1).split(';', 1)[0]);
      expect(state && binding).toBeTruthy();
      keep(`state ${secrets.size}`, state);
      keep(`binding ${secrets.size}`, binding);
      return { state, binding };
    }

    const callback = (q: Record<string, string>, binding?: string) =>
      full.app.inject({
        method: 'GET',
        url: `/auth/google/callback?${new URLSearchParams(q).toString()}`,
        cookies: binding ? { [FED_BINDING_COOKIE]: binding } : {},
      });

    beforeAll(async () => {
      keep('google client secret', GOOGLE_SECRET);
      keep('metrics token', METRICS_TOKEN);
      keep('admin token', adminToken);
      keep('client secret', client.secret);
      // A pending login context: /authorize without a session => /login?request_id=...
      const res = await get(
        `/authorize?${new URLSearchParams({
          response_type: 'code',
          client_id: client.clientId,
          redirect_uri: FLOW_REDIRECT,
          scope: 'openid',
          resource: FLOW_API_AUD,
          state: 'rp',
          code_challenge: 'x'.repeat(43),
          code_challenge_method: 'S256',
        }).toString()}`,
      );
      expect(res.statusCode).toBe(302);
      const returnTo =
        new URL(String(res.headers['location']), 'http://x').searchParams.get('returnTo') ?? '';
      requestId = new URL(returnTo, 'http://x').searchParams.get('request_id') ?? '';
      expect(requestId).toBeTruthy();
      keep('request_id', requestId);
    }, 60_000);

    it('runs the federation + admin failure paths and the log carries none of their secrets', async () => {
      const EMAIL = keep('email', `fed-${randomBytes(5).toString('hex')}@example.com`);
      const PCODE = keep('provider code', `4/0Ab-${randomBytes(20).toString('base64url')}`);
      const DESC = keep('error_description', `desc-${randomBytes(10).toString('hex')}`);
      const ERRSECRET = keep('error text secret', `errsecret-${randomBytes(10).toString('hex')}`);

      // 1) bogus state (no binding cookie) => fixed invalid_state page
      const bogus = keep('bogus state', randomBytes(24).toString('base64url'));
      const r1 = await callback({ state: bogus, code: PCODE });
      expect(r1.statusCode).toBeGreaterThanOrEqual(400);

      // 2) provider denied with an echoed error_description
      let leg = await startLeg();
      const r2 = await callback(
        { state: leg.state, error: 'access_denied', error_description: DESC },
        leg.binding,
      );
      expect(r2.statusCode).toBe(400); // provider_denied page

      // 3) provider token endpoint unreachable, error text carries code + secret
      leg = await startLeg();
      jest
        .spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new Error(`connect ECONNRESET code=${PCODE} ${ERRSECRET} ${EMAIL}`));
      const r3 = await callback({ state: leg.state, code: PCODE }, leg.binding);
      expect(r3.statusCode).toBeGreaterThanOrEqual(400);

      // 4) provider answers 400 echoing the code / client secret in the body
      leg = await startLeg();
      jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: 'invalid_grant', echo: `${PCODE} ${GOOGLE_SECRET}` }),
          {
            status: 400,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
      const r4 = await callback({ state: leg.state, code: PCODE }, leg.binding);
      expect(r4.statusCode).toBeGreaterThanOrEqual(400);

      // 5) unexpected 500 inside the callback (state store down; text carries secrets)
      leg = await startLeg();
      jest
        .spyOn(FederationStateStore.prototype, 'consume')
        .mockRejectedValueOnce(new Error(`redis down ${ERRSECRET} ${EMAIL} ${leg.state}`));
      const r5 = await callback({ state: leg.state, code: PCODE }, leg.binding);
      expect(r5.statusCode).toBe(500);
      expect(r5.headers['x-content-type-options']).toBe('nosniff');
      console.warn(`federation callback 500 cache-control=${String(r5.headers['cache-control'])}`);

      // 6) admin 500 shapes: Error with a multi-line message, a non-Error string, a plain object.
      const bearer = { authorization: `Bearer ${adminToken}` };
      jest
        .spyOn(ClientService.prototype, 'listForTenant')
        .mockRejectedValueOnce(
          Object.assign(
            new Error(`E11000 dup key: { email: "${EMAIL}" }\nnext line ${ERRSECRET}`),
            { name: 'MongoServerError', code: 11000 },
          ),
        );
      const r6 = await get('/admin/clients', bearer);
      expect(r6.statusCode).toBe(500);
      jest
        .spyOn(ClientService.prototype, 'listForTenant')
        .mockRejectedValueOnce(`plain string throw ${ERRSECRET} ${EMAIL}` as never);
      const r7 = await get('/admin/clients', bearer);
      expect(r7.statusCode).toBe(500);
      jest
        .spyOn(ClientService.prototype, 'listForTenant')
        .mockRejectedValueOnce({ message: `object throw ${ERRSECRET}`, email: EMAIL } as never);
      const r8 = await get('/admin/clients', bearer);
      expect(r8.statusCode).toBe(500);

      await new Promise((r) => setImmediate(r));

      // positive: capture is live and the federation failures were logged by fixed code
      expect(lines.some((l) => l.includes('federation failed: invalid_state'))).toBe(true);
      expect(lines.some((l) => l.includes('federation failed: provider_unavailable'))).toBe(true);
      expect(
        lines.some((l) => l.includes('/auth/google/callback') && l.includes('"statusCode":500')),
      ).toBe(true);
      expect(
        lines.some((l) => l.includes('/admin/clients') && l.includes('"statusCode":500')),
      ).toBe(true);

      const all = lines.join('\n');
      const leaked = [...secrets].filter(
        ([, v]) => all.includes(v) || all.includes(encodeURIComponent(v)),
      );
      expect(leaked.map(([label]) => label)).toEqual([]);
    }, 120_000);

    // Senior nit on errorForLog (frames kept by /^\s+at /): a message line that itself starts with
    // "    at " used to survive (DEBT-235, fixed in run 38 retry 1).
    it('DEBT-235: a message line shaped like a stack frame is not logged', async () => {
      const secret = `framesecret-${randomBytes(8).toString('hex')}`;
      jest
        .spyOn(ClientService.prototype, 'listForTenant')
        .mockRejectedValueOnce(new Error(`boom\n    at fake (${secret})`));
      const res = await get('/admin/clients', { authorization: `Bearer ${adminToken}` });
      expect(res.statusCode).toBe(500);
      await new Promise((r) => setImmediate(r));
      expect(lines.join('\n')).not.toContain(secret);
    });
  });

  // ------------------------------------------------------------------ run 38 retry 1: 4xx vs 5xx
  // Fastify core/plugin client errors must stay 4xx with no error log and no 5xx metric; a real
  // dependency failure (Mongo/Redis shaped) must stay 500 + error log + 5xx metric (fail-closed).
  describe('retry 1: Fastify client errors vs real server errors (status, error log, status_class)', () => {
    const errorLines = () => lines.filter((l) => l.includes('"level":50')).length;
    const settle = () => new Promise((r) => setImmediate(r));

    async function metricCount(route: string, cls: string): Promise<number> {
      const res = await get('/metrics', { authorization: `Bearer ${METRICS_TOKEN}` });
      expect(res.statusCode).toBe(200);
      let sum = 0;
      for (const line of res.body.split('\n')) {
        if (!line.startsWith('sso_http_request_duration_seconds_count{')) continue;
        if (!line.includes(`route="${route}"`) || !line.includes(`status_class="${cls}"`)) continue;
        sum += Number(line.slice(line.lastIndexOf(' ') + 1));
      }
      return sum;
    }

    type Case = {
      name: string;
      method: 'GET' | 'POST';
      url: string;
      route: string;
      status: number;
      headers?: Record<string, string>;
      payload?: string;
      framework?: boolean;
    };
    const json = { 'content-type': 'application/json' };
    const big = `{"a":"${'x'.repeat(1024 * 1024 + 16)}"}`;
    const cases: Case[] = [
      {
        name: 'broken JSON (anonymous admin POST)',
        method: 'POST',
        url: '/admin/clients',
        route: '/admin/clients',
        status: 400,
        headers: json,
        payload: '{"a":',
      },
      {
        name: 'broken JSON on /token',
        method: 'POST',
        url: '/token',
        route: '/token',
        status: 400,
        headers: json,
        payload: '{bad',
      },
      {
        name: 'broken JSON on HTML /login',
        method: 'POST',
        url: '/login',
        route: '/login',
        status: 400,
        headers: json,
        payload: '[',
      },
      {
        name: 'empty JSON body',
        method: 'POST',
        url: '/admin/clients',
        route: '/admin/clients',
        status: 400,
        headers: json,
        payload: '',
      },
      {
        name: 'body over 1 MiB',
        method: 'POST',
        url: '/admin/clients',
        route: '/admin/clients',
        status: 413,
        headers: json,
        payload: big,
      },
      {
        name: 'unsupported content-type',
        method: 'POST',
        url: '/admin/clients',
        route: '/admin/clients',
        status: 415,
        headers: { 'content-type': 'text/x-evilmark' },
        payload: 'hi',
      },
      {
        name: 'unsupported content-type on /token',
        method: 'POST',
        url: '/token',
        route: '/token',
        status: 415,
        headers: { 'content-type': 'application/xml' },
        payload: '<a/>',
      },
      {
        name: 'malformed percent-encoding in path',
        method: 'GET',
        url: '/assets/%E0%A4%A',
        route: '/assets/*',
        status: 400,
        framework: true,
      },
      {
        name: 'malformed percent-encoding (unmatched path)',
        method: 'GET',
        url: '/nope/%zz%',
        route: '__unmatched',
        status: 400,
        framework: true,
      },
      {
        name: 'static forbidden path',
        method: 'GET',
        url: '/assets//styles.css',
        route: '/assets/*',
        status: 403,
      },
    ];

    it.each(cases)('$name => $status, no input echo, no error log, 4xx metric only', async (c) => {
      const before4 = await metricCount(c.route, '4xx');
      const before5 = await metricCount(c.route, '5xx');
      const errBefore = errorLines();
      const res = await full.app.inject({
        method: c.method,
        url: c.url,
        headers: c.headers,
        payload: c.payload,
      });
      await settle();
      console.warn(
        `[retry1] ${c.name}: ${c.method} ${c.url.slice(0, 40)} -> ${res.statusCode} cc=${String(res.headers['cache-control'])} ${res.body.slice(0, 120)}`,
      );
      expect(res.statusCode).toBe(c.status);
      if (!c.framework) {
        // through the global filter: no-store, body never quotes request input
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body).not.toMatch(/evilmark|<a\/>|\{bad|xxxxxxxx|styles\.css/);
      } else {
        // Fastify onBadUrl answers before any route/filter (pre-existing): recorded, see report
        console.warn(`[retry1] badurl headers ${JSON.stringify(res.headers)}`);
      }
      expect(errorLines()).toBe(errBefore);
      expect(await metricCount(c.route, '5xx')).toBe(before5);
      // onBadUrl also skips the onResponse hook: not counted at all (DEBT-239), never as 5xx
      expect(await metricCount(c.route, '4xx')).toBe(before4 + (c.framework ? 0 : 1));
    });

    it.each([
      [
        'MongoServerError E11000',
        Object.assign(new Error('E11000 dup key'), { name: 'MongoServerError', code: 11000 }),
      ],
      [
        'MongoNetworkError',
        Object.assign(new Error('connection 1 to localhost:27117 closed'), {
          name: 'MongoNetworkError',
        }),
      ],
      [
        'ioredis ECONNREFUSED',
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6479'), {
          code: 'ECONNREFUSED',
          errno: -111,
        }),
      ],
      [
        'dependency Error with statusCode 503',
        Object.assign(new Error('upstream'), { statusCode: 503 }),
      ],
      ['Error with status 404 (not statusCode)', Object.assign(new Error('nf'), { status: 404 })],
      ['Error with statusCode string "403"', Object.assign(new Error('s'), { statusCode: '403' })],
    ])(
      '%s thrown on an admin route => 500 server_error + error log + 5xx metric',
      async (_n, err) => {
        const before5 = await metricCount('/admin/clients', '5xx');
        const before4 = await metricCount('/admin/clients', '4xx');
        const errBefore = errorLines();
        jest.spyOn(ClientService.prototype, 'listForTenant').mockRejectedValueOnce(err as never);
        const res = await get('/admin/clients', { authorization: `Bearer ${adminToken}` });
        await settle();
        expect(res.statusCode).toBe(500);
        expect(res.json<{ error: string }>().error).toBe('server_error');
        expect(errorLines()).toBeGreaterThan(errBefore);
        expect(await metricCount('/admin/clients', '5xx')).toBe(before5 + 1);
        expect(await metricCount('/admin/clients', '4xx')).toBe(before4);
      },
    );

    it('Redis-shaped failure on the HTML /authorize path => 500 HTML + 5xx metric (not hidden as 4xx)', async () => {
      const before5 = await metricCount('/authorize', '5xx');
      jest
        .spyOn(ClientService.prototype, 'findByClientId')
        .mockRejectedValueOnce(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      const res = await get(
        `/authorize?${new URLSearchParams({
          response_type: 'code',
          client_id: client.clientId,
          redirect_uri: FLOW_REDIRECT,
          scope: 'openid',
          code_challenge: 'x'.repeat(43),
          code_challenge_method: 'S256',
        }).toString()}`,
      );
      await settle();
      expect(res.statusCode).toBe(500);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(await metricCount('/authorize', '5xx')).toBe(before5 + 1);
    });
  });
});
