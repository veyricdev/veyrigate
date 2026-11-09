import { jest } from '@jest/globals';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { Types, type Model } from 'mongoose';
import { ClientCredentialService } from '../src/modules/clients/client-credential.service';
import { ClientService } from '../src/modules/clients/client.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { TokenSigner } from '../src/modules/keys/token-signer';
import { SESSION_COOKIE } from '../src/modules/sessions/session.cookie';
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
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';
import { seedConsent, seedOAuthUser } from './oauth-fixtures';

/**
 * Run 80 tester, on the REAL app (`AppModule` + `configureApp`) over HTTP:
 * - T4 DEBT-325: the 4 `@SuperAdminOnly()` routes × {tenant_admin, super_admin} × {stale, fresh}
 *   auth_time; tenant_admin answers are byte-identical whatever the auth_time (no step-up oracle);
 *   scope still checked first; state (resources, JWKS, audit) untouched on refusal.
 * - T3 DEBT-324/329: identifier corpus through `POST /admin/resources` (fixed messages, no echo, no
 *   document, no audit); a LEGACY resource stored directly with an identifier the write path now
 *   refuses still takes a scopes PATCH and still works at `/authorize` + `/token` (runtime unchanged).
 * - T2 DEBT-237: a real UI 500 is logged by HtmlExceptionFilter with `errorForLog` only.
 * - OpenAPI: the document the BE serves equals the hand-edited snapshot `fe-admin/openapi/admin.json`.
 */
const MIN = 60_000;
const SECRET = 'r80t-SECRET-token-xyz';
const SECRET_EMAIL = 'r80t-leak@example.com';
const CHAR_MSG = 'resource identifier must not contain whitespace or control characters';
const SCHEME_MSG = 'resource identifier scheme must be https, http or urn';

describe('run 80 tester: super_admin-only order, identifier rules, UI 500 log, OpenAPI', () => {
  let full: FullApp;
  let bff: { clientId: string; secret: string };
  let resourceModel: Model<Record<string, unknown>>;
  let auditModel: Model<Record<string, unknown>>;
  const ids = { superA: '', tenantA: '' };
  const pino: string[] = [];

  const boot = async (): Promise<void> => {
    full = await bootFullApp({
      name: 'run80t',
      logStream: new Writable({
        write(chunk, _e, cb) {
          pino.push(...String(chunk).split('\n').filter(Boolean));
          cb();
        },
      }),
    });
    resourceModel = full.conn.model<Record<string, unknown>>('Resource');
    auditModel = full.conn.model<Record<string, unknown>>('AuditLog');
    bff = await seedFlowClient(full);
    ids.superA = await adminUser('super_admin');
    ids.tenantA = await adminUser('tenant_admin');
  };
  let setup: Promise<void> | undefined;
  beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await settled(setup);
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

  const jwksKids = async () =>
    (
      (await full.app.inject({ method: 'GET', url: '/jwks.json' })).json() as {
        keys: { kid: string }[];
      }
    ).keys
      .map((k) => k.kid)
      .sort();

  // ------------------------------------------------------------------ T4 DEBT-325

  describe('T4 DEBT-325: @SuperAdminOnly() routes, actor × auth_time matrix', () => {
    type Route = {
      name: string;
      method: 'GET' | 'POST' | 'PATCH';
      url: string;
      body?: () => unknown;
      fresh: number;
    };
    let n = 0;
    const routes: Route[] = [
      { name: 'GET /admin/keys', method: 'GET', url: '/admin/keys', fresh: 200 },
      {
        name: 'POST /admin/keys/rotate',
        method: 'POST',
        url: '/admin/keys/rotate',
        body: () => ({ mode: 'normal' }),
        fresh: 200,
      },
      {
        name: 'POST /admin/resources',
        method: 'POST',
        url: '/admin/resources',
        body: () => ({
          resourceId: `r80t-m${++n}`,
          identifier: `https://r80t-m${n}.example.com/`,
        }),
        fresh: 201,
      },
      {
        name: 'PATCH /admin/resources/api',
        method: 'PATCH',
        url: '/admin/resources/api',
        body: () => ({ scopes: ['api.read'] }),
        fresh: 200,
      },
    ];

    it.each(routes.map((r) => [r.name, r] as const))(
      '%s: tenant_admin stale/fresh ⇒ identical 403 forbidden, super_admin stale ⇒ step_up_required, fresh ⇒ 2xx; refusals change nothing',
      async (_name, r) => {
        // Only the GET is not step-up protected (no RequireRecentAuth): stale super_admin is 200.
        const stepUp = r.method !== 'GET';
        const snapshot = async () => ({
          resources: await resourceModel.find({}, { _id: 0 }).sort({ identifier: 1 }).lean(),
          kids: await jwksKids(),
          audits: await auditModel.countDocuments({}),
        });
        const before = await snapshot();
        const taStale = await call(r.method, r.url, await tok(ids.tenantA, 6 * MIN), r.body?.());
        const taFresh = await call(r.method, r.url, await tok(ids.tenantA), r.body?.());
        for (const res of [taStale, taFresh]) {
          expect(res.statusCode).toBe(403);
          expect(res.json()).toEqual({ error: 'forbidden' });
          expect(res.body).not.toMatch(/step_up|max_age|super_admin/);
          expect(String(res.headers['www-authenticate'] ?? '')).not.toMatch(/max_age|step_up/);
          expect(res.headers['cache-control']).toBe('no-store');
        }
        // No oracle: the stale answer is byte-identical to the fresh one.
        expect(taStale.body).toBe(taFresh.body);
        expect(taStale.headers['www-authenticate']).toEqual(taFresh.headers['www-authenticate']);
        // Scope is still checked before the role (order unchanged for steps 1-7).
        if (r.method !== 'GET') {
          const noScope = await call(
            r.method,
            r.url,
            await tok(ids.tenantA, 6 * MIN, 'openid admin.read'),
            r.body?.(),
          );
          expect(noScope.statusCode).toBe(403);
          expect(noScope.json().error).toBe('insufficient_scope');
        }
        expect(await snapshot()).toEqual(before);

        const saStale = await call(r.method, r.url, await tok(ids.superA, 6 * MIN), r.body?.());
        if (stepUp) {
          expect(saStale.statusCode).toBe(403);
          expect(saStale.json()).toMatchObject({ error: 'step_up_required' });
          expect(await snapshot()).toEqual(before);
        } else {
          expect(saStale.statusCode).toBe(200);
        }
        const saFresh = await call(r.method, r.url, await tok(ids.superA), r.body?.());
        expect(saFresh.statusCode).toBe(r.fresh);
      },
    );

    it('tenant_admin keeps reads that are not super_admin-only (resources list/get, tenants, audit, me)', async () => {
      const t = await tok(ids.tenantA, 6 * MIN);
      for (const url of [
        '/admin/resources?limit=5',
        '/admin/resources/api',
        '/admin/tenants',
        '/admin/audit?limit=1',
        '/admin/me',
      ]) {
        const res = await call('GET', url, t);
        expect({ url, status: res.statusCode }).toEqual({ url, status: 200 });
      }
    });
  });

  // ------------------------------------------------------------------ T3 DEBT-324/329/531

  describe('T3: identifier rules on the write path, runtime unchanged', () => {
    const refused: [string, string, string][] = [
      ['U+0000 leading', '\u0000https://r80t-a.example.com/', CHAR_MSG],
      ['U+0000 middle', 'https://r80t-a.example.com/\u0000x', CHAR_MSG],
      ['U+200B (Cf)', 'https://r80t-a.example.com/​', CHAR_MSG],
      ['U+FEFF BOM (Cf)', '﻿https://r80t-a.example.com/', CHAR_MSG],
      ['U+202E bidi (Cf)', 'https://r80t-a.example.com/‮evil', CHAR_MSG],
      ['U+00A0 NBSP (Zs)', 'https://r80t-a.example.com/a b', CHAR_MSG],
      ['U+2028 (Zl)', 'https://r80t-a.example.com/a b', CHAR_MSG],
      ['U+3000 (Zs)', 'https://r80t-a.example.com/　', CHAR_MSG],
      ['tab middle', 'https://r80t-a.example.com/a\tb', CHAR_MSG],
      ['LF middle', 'https://r80t-a.example.com/a\nb', CHAR_MSG],
      ['CR middle', 'https://r80t-a.example.com/a\rb', CHAR_MSG],
      ['DEL U+007F', 'https://r80t-a.example.com/a\u007fb', CHAR_MSG],
      ['C1 U+0085', 'https://r80t-a.example.com/a\u0085b', CHAR_MSG],
      ['tab inside host', 'https://r80t-\ta.example.com/', CHAR_MSG],
      ['javascript:', 'javascript:alert(document.cookie)', SCHEME_MSG],
      ['JAVASCRIPT: upper', 'JAVASCRIPT:alert(1)', SCHEME_MSG],
      ['mailto:', 'mailto:r80t@example.com', SCHEME_MSG],
      ['data:', 'data:text/html;base64,PHNjcmlwdD4=', SCHEME_MSG],
      ['file:', 'file:///etc/passwd', SCHEME_MSG],
      ['ftp:', 'ftp://r80t-a.example.com/', SCHEME_MSG],
      ['ws:', 'ws://r80t-a.example.com/', SCHEME_MSG],
      ['blob:', 'blob:https://r80t-a.example.com/x', SCHEME_MSG],
    ];
    const accepted = [
      'HTTPS://R80T-UP.EXAMPLE.COM/',
      'Https://r80t-mixed.example.com/a',
      'http://localhost:3000/r80t/',
      'urn:example:r80t',
      'URN:example:r80t-up',
      'https://r80t-pct.example.com/a%20b%00',
    ];

    it.each(refused)(
      '%s ⇒ 400 invalid_request with the fixed message, no echo, 0 document, 0 audit',
      async (_label, identifier, message) => {
        const t = await tok(ids.superA);
        const docs = await resourceModel.countDocuments({});
        const audits = await auditModel.countDocuments({ action: 'ADMIN_RESOURCE_CREATED' });
        const resourceId = `r80t-bad-${randomUUID().slice(0, 8)}`;
        const res = await call('POST', '/admin/resources', t, { resourceId, identifier });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: 'invalid_request', error_description: message });
        for (const piece of ['r80t-a', 'alert', 'passwd', 'PHNj', 'r80t@example.com', 'evil']) {
          expect(res.body).not.toContain(piece);
        }
        expect(await resourceModel.countDocuments({})).toBe(docs);
        expect(await resourceModel.countDocuments({ resourceId })).toBe(0);
        expect(await auditModel.countDocuments({ action: 'ADMIN_RESOURCE_CREATED' })).toBe(audits);
      },
    );

    it.each(accepted)('%j ⇒ 201, stored byte-for-byte (no normalisation)', async (identifier) => {
      const resourceId = `r80t-ok-${randomUUID().slice(0, 8)}`;
      const res = await call('POST', '/admin/resources', await tok(ids.superA), {
        resourceId,
        identifier,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().identifier).toBe(identifier);
      expect((await resourceModel.findOne({ resourceId }).lean())?.identifier).toBe(identifier);
    });

    it('LEGACY resources (stored before the rule) still take a scopes PATCH and still work at /authorize + /token', async () => {
      const legacy = [
        { resourceId: 'r80t-legacy-ws', identifier: 'https://r80t-legacy.example.com/a b' },
        { resourceId: 'r80t-legacy-ftp', identifier: 'ftp://r80t-legacy.example.com/' },
        { resourceId: 'r80t-legacy-zw', identifier: 'https://r80t-legacy.example.com/z​' },
      ];
      // Direct insert (bypasses the service): what an older deployment may already hold.
      await resourceModel.insertMany(legacy.map((l) => ({ ...l, scopes: ['l.read'] })));

      const t = await tok(ids.superA);
      for (const l of legacy) {
        const res = await call('PATCH', `/admin/resources/${l.resourceId}`, t, {
          scopes: ['l.read', 'l.write'],
        });
        expect({ id: l.resourceId, status: res.statusCode }).toEqual({
          id: l.resourceId,
          status: 200,
        });
        expect(res.json()).toEqual({ ...l, scopes: ['l.read', 'l.write'] });
      }
      expect(
        await auditModel.countDocuments({
          action: 'ADMIN_RESOURCE_UPDATED',
          targetId: { $in: legacy.map((l) => l.resourceId) },
        }),
      ).toBe(3);

      // Runtime: a client allowed on the legacy resources still gets a code and an AT with aud =
      // the raw stored string (validateResourceFormat only on /authorize + /token).
      const clientId = `r80t-legacy-${randomUUID()}`;
      await full.app.get(ClientService).create({
        clientId,
        clientType: 'confidential',
        tokenEndpointAuthMethod: 'client_secret_basic',
        redirectUris: [FLOW_REDIRECT],
        allowedResources: legacy.map((l) => l.resourceId),
        scopes: ['openid', 'l.read'],
        grantTypes: ['authorization_code', 'refresh_token'],
        tenantId: DEFAULT_TENANT_ID,
      });
      const { secret } = await full.app.get(ClientCredentialService).createSecret(clientId);
      const user = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
      const sessionId = (await full.app.get(SessionService).create(user, DEFAULT_TENANT_ID)).id;
      for (const l of legacy) {
        await seedConsent(full.conn, {
          userId: user,
          clientId,
          resource: l.identifier,
          scopes: ['openid', 'l.read'],
        });
        const verifier = randomBytes(32).toString('base64url');
        const code = await authorizeCode(full, {
          clientId,
          sessionId,
          resource: l.identifier,
          scope: 'openid l.read',
          verifier,
        });
        const tr = await formPost(
          full,
          '/token',
          { clientId, secret },
          {
            grant_type: 'authorization_code',
            code,
            redirect_uri: FLOW_REDIRECT,
            code_verifier: verifier,
          },
        );
        expect({ id: l.resourceId, status: tr.statusCode }).toEqual({
          id: l.resourceId,
          status: 200,
        });
        const at = tr.json<{ access_token: string }>().access_token;
        const aud = JSON.parse(Buffer.from(at.split('.')[1], 'base64url').toString('utf8')).aud;
        expect(aud).toBe(l.identifier);
      }
    });
  });

  // ------------------------------------------------------------------ T2 DEBT-237

  describe('T2 DEBT-237: a real UI 500 is logged with errorForLog only', () => {
    it('GET / with a session whose lookup throws a secret-bearing Error ⇒ 500 page, one HtmlExceptionFilter ERROR line, no message/secret anywhere in logs or body', async () => {
      const user = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
      const sessionId = (await full.app.get(SessionService).create(user, DEFAULT_TENANT_ID)).id;
      const from = pino.length;
      jest
        .spyOn(full.app.get(SessionService), 'get')
        .mockRejectedValueOnce(new Error(`boom ${SECRET} for ${SECRET_EMAIL}`));
      const res = await full.app.inject({
        method: 'GET',
        url: '/',
        cookies: { [SESSION_COOKIE]: sessionId },
      });
      expect(res.statusCode).toBe(500);
      expect(String(res.headers['content-type'])).toContain('text/html');
      expect(res.body).not.toContain(SECRET);
      expect(res.body).not.toContain(SECRET_EMAIL);
      const lines = pino.slice(from);
      const filterLines = lines.filter((l) => l.includes('HtmlExceptionFilter'));
      expect(filterLines).toHaveLength(1);
      const entry = JSON.parse(filterLines[0]) as { level: number; msg?: string };
      expect(entry.level).toBeGreaterThanOrEqual(50);
      expect(filterLines[0]).toContain('Error');
      for (const l of lines) {
        expect(l).not.toContain(SECRET);
        expect(l).not.toContain(SECRET_EMAIL);
        expect(l).not.toContain(sessionId);
      }
    });

    it('4xx on HTML routes ⇒ no HtmlExceptionFilter line (client input cannot fill the log)', async () => {
      const from = pino.length;
      const bad = await full.app.inject({
        method: 'POST',
        url: '/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: `email=${encodeURIComponent(SECRET_EMAIL)}&password=x&_csrf=${SECRET}`,
      });
      expect(bad.statusCode).toBeGreaterThanOrEqual(400);
      expect(bad.statusCode).toBeLessThan(500);
      const unsupported = await full.app.inject({
        method: 'POST',
        url: '/login',
        headers: { 'content-type': 'text/x-r80t' },
        payload: SECRET,
      });
      expect(unsupported.statusCode).toBe(415);
      const lines = pino.slice(from);
      expect(lines.filter((l) => l.includes('HtmlExceptionFilter'))).toHaveLength(0);
      for (const l of lines) expect(l).not.toContain(SECRET);
    });
  });

  // ------------------------------------------------------------------ OpenAPI snapshot

  it('OpenAPI: the document the BE serves equals the hand-edited fe-admin/openapi/admin.json', async () => {
    const res = await full.app.inject({ method: 'GET', url: '/openapi/admin.json' });
    expect(res.statusCode).toBe(200);
    const served = res.json() as {
      components: { schemas: Record<string, { properties: Record<string, unknown> }> };
    };
    const snapshot = JSON.parse(
      await readFile(join(process.cwd(), '..', 'fe-admin', 'openapi', 'admin.json'), 'utf8'),
    );
    expect(served.components.schemas.CreateResourceDto.properties.identifier).toEqual({
      type: 'string',
      maxLength: expect.any(Number),
      description:
        'Absolute https, http or urn URI without fragment, whitespace or control characters (the `aud`).',
    });
    expect(served).toEqual(snapshot);
  });
});
