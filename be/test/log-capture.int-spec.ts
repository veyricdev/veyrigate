import { jest } from '@jest/globals';
import { Types } from 'mongoose';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { MongoService } from '../src/database/mongo/mongo.service';
import { ClientAuthenticationService } from '../src/modules/clients/client-authentication.service';
import { ClientService } from '../src/modules/clients/client.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { SESSION_COOKIE } from '../src/modules/sessions/session.cookie';
import {
  authorizeCode,
  basicAuth,
  bootFullApp,
  FLOW_ADMIN_AUD,
  FLOW_API_AUD,
  FLOW_REDIRECT,
  formPost,
  seedFlowClient,
  type FullApp,
  type InjectResponse,
} from './full-app';
import { seedConsent } from './oauth-fixtures';

/**
 * Application log review (B7.4 Task 4, INV-20). The real app (`configureApp` + nestjs-pino with
 * the production `buildPinoHttpOptions`) writes into memory while a full flow runs: register,
 * verify email, password login, /authorize + /token (code + PKCE), refresh, /userinfo,
 * /introspect, /revoke, an admin call, /metrics, and the failure paths (500 whose error text carries
 * the email + a token, Mongo/readiness errors whose text carries a URI with credentials). Every
 * secret value actually used must be absent from the captured log (raw and URL-encoded).
 * Federation is reviewed statically only (its log lines print fixed codes).
 */
describe('application logs never carry secrets (B7.4)', () => {
  let full: FullApp;
  const lines: string[] = [];
  const secrets = new Map<string, string>();
  const keep = (label: string, value: string | undefined) => {
    if (!value) throw new Error(`missing ${label}`);
    secrets.set(label, value);
    return value;
  };

  const METRICS_TOKEN = randomBytes(32).toString('hex');
  const EMAIL = `logcap-${randomBytes(6).toString('hex')}@example.com`;
  const PASSWORD = `pw-${randomBytes(12).toString('base64url')}`;
  const URI_PASSWORD = `uriPw${randomBytes(8).toString('hex')}`;

  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(...String(chunk).split('\n').filter(Boolean));
      cb();
    },
  });

  const cookieOf = (res: InjectResponse, name: string): string | undefined => {
    const raw = res.headers['set-cookie'];
    const all = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
    const hit = all.find((c) => c.startsWith(`${name}=`));
    return hit ? decodeURIComponent(hit.slice(name.length + 1).split(';', 1)[0]) : undefined;
  };
  const csrfOf = (html: string) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
  const form = (url: string, cookies: Record<string, string>, fields: Record<string, string>) =>
    full.app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      cookies,
      payload: new URLSearchParams(fields).toString(),
    });

  beforeAll(async () => {
    keep('metrics token', METRICS_TOKEN);
    keep('email', EMAIL);
    keep('password', PASSWORD);
    keep('uri password', URI_PASSWORD);
    full = await bootFullApp({ name: 'logs', env: { METRICS_TOKEN }, logStream: stream });
    const client = await seedFlowClient(full);
    keep('client secret', client.secret);
    keep('basic header', basicAuth(client.clientId, client.secret));

    // Register -> verify email -> password login (real UI forms + CSRF).
    const regPage = await full.app.inject({ method: 'GET', url: '/register' });
    const anon = keep('anon csrf cookie', cookieOf(regPage, 'idp_csrf'));
    const csrf = keep('csrf token', csrfOf(regPage.body));
    const reg = await form(
      '/register',
      { idp_csrf: anon },
      { _csrf: csrf, email: EMAIL, password: PASSWORD },
    );
    expect(reg.statusCode).toBeLessThan(300);
    const link = full.outbox.find((m) => m.to === EMAIL)?.text.match(/https?:\/\/\S+/)?.[0];
    const verifyToken = keep(
      'verify token',
      new URL(link ?? 'http://x/').searchParams.get('token') ?? '',
    );
    expect(
      (await full.app.inject({ method: 'GET', url: `/verify-email?token=${verifyToken}` }))
        .statusCode,
    ).toBe(200);
    const verified = await form(
      '/verify-email',
      { idp_csrf: anon },
      { _csrf: csrf, token: verifyToken },
    );
    expect(verified.statusCode).toBeLessThan(300);
    const login = await form(
      '/login',
      { idp_csrf: anon },
      { _csrf: csrf, email: EMAIL, password: PASSWORD },
    );
    expect(login.statusCode).toBe(302);
    const sessionId = keep('session cookie', cookieOf(login, SESSION_COOKIE));

    const user = (await full.conn.model('User').findOne({ email: EMAIL }).lean()) as {
      _id: Types.ObjectId;
    } | null;
    const userId = user!._id.toHexString();
    await full.conn
      .model('UserTenant')
      .updateOne(
        { userId: user!._id, tenantId: DEFAULT_TENANT_ID },
        { $set: { roles: ['tenant_admin'] } },
      );
    await seedConsent(full.conn, {
      userId,
      clientId: client.clientId,
      resource: FLOW_API_AUD,
      scopes: ['openid', 'email', 'offline_access', 'api.read'],
    });
    await seedConsent(full.conn, {
      userId,
      clientId: client.clientId,
      resource: FLOW_ADMIN_AUD,
      scopes: ['openid', 'admin.read'],
    });

    const codeFlow = async (resource: string, scope: string, label: string) => {
      const verifier = keep(`${label} code_verifier`, randomBytes(32).toString('base64url'));
      const code = keep(
        `${label} code`,
        await authorizeCode(full, { ...client, sessionId, resource, scope, verifier }),
      );
      const res = await formPost(full, '/token', client, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: FLOW_REDIRECT,
        code_verifier: verifier,
      });
      expect(res.statusCode).toBe(200);
      return res.json<{ access_token: string; refresh_token?: string; id_token?: string }>();
    };

    const api = await codeFlow(FLOW_API_AUD, 'openid email offline_access api.read', 'api');
    keep('access token', api.access_token);
    keep('refresh token', api.refresh_token);
    keep('id token', api.id_token);
    const refreshed = await formPost(full, '/token', client, {
      grant_type: 'refresh_token',
      refresh_token: api.refresh_token!,
    });
    expect(refreshed.statusCode).toBe(200);
    const at2 = keep(
      'refreshed access token',
      refreshed.json<{ access_token: string }>().access_token,
    );
    const rt2 = keep(
      'refreshed refresh token',
      refreshed.json<{ refresh_token: string }>().refresh_token,
    );

    expect(
      (
        await full.app.inject({
          method: 'GET',
          url: '/userinfo',
          headers: { authorization: `Bearer ${at2}` },
        })
      ).statusCode,
    ).toBe(200);
    expect((await formPost(full, '/introspect', client, { token: at2 })).json()).toMatchObject({
      active: true,
    });
    expect((await formPost(full, '/revoke', client, { token: rt2 })).statusCode).toBe(200);

    const admin = keep(
      'admin token',
      (await codeFlow(FLOW_ADMIN_AUD, 'openid admin.read', 'admin')).access_token,
    );
    expect(
      (
        await full.app.inject({
          method: 'GET',
          url: '/admin/clients',
          headers: { authorization: `Bearer ${admin}` },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await full.app.inject({
          method: 'GET',
          url: '/metrics',
          headers: { authorization: `Bearer ${METRICS_TOKEN}` },
        })
      ).statusCode,
    ).toBe(200);

    // Failure paths whose ERROR TEXT carries secrets.
    const dupKey = () =>
      Object.assign(
        new Error(
          `E11000 duplicate key error collection: sso.users index: email_1 dup key: { email: "${EMAIL}" } token=${at2}`,
        ),
        { name: 'MongoServerError', code: 11000 },
      );
    jest
      .spyOn(full.app.get(ClientAuthenticationService), 'authenticate')
      .mockRejectedValueOnce(dupKey());
    expect(
      (await formPost(full, '/token', client, { grant_type: 'refresh_token', refresh_token: 'x' }))
        .statusCode,
    ).toBe(500);
    jest
      .spyOn(full.app.get(ClientAuthenticationService), 'authenticate')
      .mockRejectedValueOnce(dupKey());
    expect((await formPost(full, '/introspect', client, { token: at2 })).statusCode).toBe(500);
    jest.spyOn(full.app.get(ClientService), 'listForTenant').mockRejectedValueOnce(dupKey());
    expect(
      (
        await full.app.inject({
          method: 'GET',
          url: '/admin/clients',
          headers: { authorization: `Bearer ${admin}` },
        })
      ).statusCode,
    ).toBe(500);

    const uriError = () =>
      new Error(`connect failed for mongodb://sso-app:${URI_PASSWORD}@db.internal:27017/sso`);
    jest.spyOn(full.app.get(MongoService), 'ping').mockRejectedValueOnce(uriError());
    expect((await full.app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(503);
    full.conn.emit('error', uriError());

    // pino writes synchronously to the stream; one tick for any pending `res.on('finish')` line.
    await new Promise((r) => setImmediate(r));
  }, 120_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    if (full) await full.close();
  });

  it('capture is live: access lines carry req.id + statusCode, and the 500/URI errors were logged', () => {
    const entries = lines.map(
      (l) =>
        JSON.parse(l) as {
          msg?: string;
          req?: { id?: unknown; url?: string };
          res?: { statusCode?: unknown };
        },
    );
    const access = entries.filter((e) => e.msg === 'request completed');
    expect(access.length).toBeGreaterThanOrEqual(10);
    expect(
      access.every((e) => typeof e.req?.id === 'string' && typeof e.res?.statusCode === 'number'),
    ).toBe(true);
    // pino-http logs a 5xx as 'request errored' (not 'completed').
    expect(entries.some((e) => e.req?.url === '/token' && e.res?.statusCode === 500)).toBe(true);
    expect(lines.filter((l) => l.includes('MongoServerError')).length).toBeGreaterThanOrEqual(3);
    expect(lines.some((l) => l.includes('readiness check failed'))).toBe(true);
    expect(lines.some((l) => l.includes('Mongo error'))).toBe(true);
  });

  it('no secret value appears in any log line (raw or URL-encoded)', () => {
    const all = lines.join('\n');
    const leaked = [...secrets].filter(
      ([, v]) => all.includes(v) || all.includes(encodeURIComponent(v)),
    );
    expect(leaked.map(([label]) => label)).toEqual([]);
  });
});
