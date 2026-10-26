import { jest } from '@jest/globals';
import IORedis from 'ioredis';
import { randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { Types, type Model } from 'mongoose';
import { sha256 } from '../src/common/crypto/crypto.util';
import { ClientCredentialService } from '../src/modules/clients/client-credential.service';
import { ClientService } from '../src/modules/clients/client.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { RefreshTokenService } from '../src/modules/oauth/token/refresh-token.service';
import { ResourceService } from '../src/modules/resources/resource.service';
import { SESSION_COOKIE } from '../src/modules/sessions/session.cookie';
import { SessionService } from '../src/modules/sessions/session.service';
import {
  authorizeCode,
  bootFullApp,
  FLOW_ADMIN_AUD,
  FLOW_API_AUD,
  FLOW_REDIRECT,
  FULL_APP_ISSUER,
  formPost,
  seedFlowClient,
  type FullApp,
  type InjectResponse,
} from './full-app';
import { seedConsent, seedOAuthUser } from './oauth-fixtures';

/**
 * Tester risk tests, run 55 (OAuth security sweep), on the REAL app over HTTP (real CSRF, real
 * cookies, real /token, /userinfo, /introspect, admin API). Independent of the dev suites:
 * - DEBT-123: consent `request_id` transplanted into another session — approve, deny, double
 *   submit, concurrent with the owner, after the owner logged out, same user in a second session;
 * - DEBT-130: deny after the redirect_uri was removed / the client disabled; step-up
 *   (`prompt=login&max_age=0`) resume with the old session or no session after the URI is gone;
 * - DEBT-177: `aud=admin` AT of a client downgraded to {public,none} / {confidential,none} is dead
 *   at /userinfo, /introspect and the admin API, while the same client's ordinary AT keeps working;
 * - DEBT-216: refresh after the family's resource left `allowedResources` (plain and racing the
 *   rotate), admin variant with replay; retries are never reuse;
 * - exposure: no JWT / session ref in the app log or the audit trail.
 */
const OTHER_REDIRECT = 'https://app.example.com/other';
const OTHER_AUD = 'https://other.example.com/';
const ADMIN_SCOPE = 'openid admin.read admin.write offline_access';
const API_SCOPE = 'openid offline_access api.read';
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./;

type Auth = { clientId: string; secret: string };
type Tokens = { access_token: string; refresh_token: string };

describe('run 55 tester: OAuth sweep risk tests (DEBT-123/130/177/216) over real HTTP', () => {
  let full: FullApp;
  let redis: IORedis;
  let rs: Auth; // resource server allowed to introspect `api` + `admin` tokens
  let clientModel: Model<Record<string, unknown>>;
  let auditModel: Model<Record<string, unknown>>;
  let rtModel: Model<Record<string, unknown>>;
  let consentModel: Model<Record<string, unknown>>;
  const pino: string[] = [];
  let n = 0;

  beforeAll(async () => {
    full = await bootFullApp({
      name: 'run55t',
      logStream: new Writable({
        write(chunk, _e, cb) {
          pino.push(String(chunk));
          cb();
        },
      }),
    });
    redis = new IORedis(process.env.TEST_REDIS_URL ?? 'redis://localhost:6479', {
      maxRetriesPerRequest: 1,
    });
    clientModel = full.conn.model<Record<string, unknown>>('Client');
    auditModel = full.conn.model<Record<string, unknown>>('AuditLog');
    rtModel = full.conn.model<Record<string, unknown>>('RefreshToken');
    consentModel = full.conn.model<Record<string, unknown>>('Consent');
    await seedFlowClient(full); // resources `api` + `admin`
    await full.app.get(ResourceService).create({
      resourceId: 'other',
      identifier: OTHER_AUD,
      scopes: ['api.read'],
    });
    rs = await mkConfidential(['api', 'admin'], ['openid']);
  }, 90_000);

  afterAll(async () => {
    await redis?.quit();
    if (full) await full.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------- helpers

  async function mkConfidential(allowedResources: string[], scopes: string[]): Promise<Auth> {
    const clientId = `r55t-conf-${++n}-${randomUUID()}`;
    await full.app.get(ClientService).create({
      clientId,
      clientType: 'confidential',
      tokenEndpointAuthMethod: 'client_secret_basic',
      redirectUris: [FLOW_REDIRECT],
      allowedResources,
      scopes,
      grantTypes: ['authorization_code', 'refresh_token'],
      tenantId: DEFAULT_TENANT_ID,
    });
    const { secret } = await full.app.get(ClientCredentialService).createSecret(clientId);
    return { clientId, secret };
  }

  async function mkConsentClient(): Promise<string> {
    const clientId = `r55t-pub-${++n}-${randomUUID()}`;
    await full.app.get(ClientService).create({
      clientId,
      clientType: 'public',
      tokenEndpointAuthMethod: 'none',
      redirectUris: [FLOW_REDIRECT, OTHER_REDIRECT],
      allowedResources: [],
      scopes: ['openid', 'profile'],
      tenantId: DEFAULT_TENANT_ID,
    });
    return clientId;
  }

  const sessionIds: string[] = [];
  const newSession = async (userId: string) => {
    const { id } = await full.app.get(SessionService).create(userId, DEFAULT_TENANT_ID);
    sessionIds.push(id);
    return id;
  };

  const authorizeUrl = (clientId: string, extra = '') =>
    `/authorize?response_type=code&client_id=${clientId}` +
    `&redirect_uri=${encodeURIComponent(FLOW_REDIRECT)}` +
    `&scope=${encodeURIComponent('openid profile')}&state=victim-state&nonce=rp-nonce` +
    `&code_challenge=${encodeURIComponent('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')}` +
    `&code_challenge_method=S256${extra}`;

  /** Render the consent screen for `sessionId` => its CSRF token + request_id. */
  async function screen(clientId: string, sessionId: string) {
    const res = await full.app.inject({
      method: 'GET',
      url: authorizeUrl(clientId),
      cookies: { [SESSION_COOKIE]: sessionId },
    });
    expect(res.statusCode).toBe(200);
    const csrf = res.body.match(/name="_csrf" value="([^"]+)"/)?.[1];
    const requestId = res.body.match(/name="request_id" value="([^"]+)"/)?.[1];
    expect(csrf && requestId).toBeTruthy();
    return { csrf: csrf!, requestId: requestId! };
  }

  const decide = (sessionId: string, csrf: string, requestId: string, approve: boolean) =>
    full.app.inject({
      method: 'POST',
      url: '/authorize/consent',
      cookies: { [SESSION_COOKIE]: sessionId },
      payload: { _csrf: csrf, request_id: requestId, approve: String(approve) },
    }) as Promise<InjectResponse>;

  const codeKeys = async () => (await redis.keys('authz_code:*')).length;
  const consentAudits = (userId: string) =>
    auditModel.countDocuments({
      actorId: userId,
      action: { $in: ['OAUTH_CONSENT_GRANTED', 'OAUTH_CONSENT_DENIED'] },
    });
  const consents = (userId: string) =>
    consentModel.countDocuments({ userId: new Types.ObjectId(userId) });

  /** First-party page: 400, no Location, nothing of the RP request (state/URI/code) echoed. */
  function expectFirstPartyPage(res: InjectResponse) {
    expect(res.statusCode).toBe(400);
    expect(res.headers['location']).toBeUndefined();
    expect(res.body).not.toContain('victim-state');
    expect(res.body).not.toContain('app.example.com');
    expect(res.body).not.toMatch(/[?&]code=/);
  }

  function expectRedirect(res: InjectResponse, kind: 'code' | 'access_denied' | 'login_required') {
    expect(res.statusCode).toBe(302);
    const url = new URL(String(res.headers['location']));
    expect(url.origin + url.pathname).toBe(FLOW_REDIRECT);
    expect(url.searchParams.get('state')).toBe('victim-state');
    expect(url.searchParams.get('iss')).toBe(FULL_APP_ISSUER);
    if (kind === 'code') expect(url.searchParams.get('code')).toBeTruthy();
    else expect(url.searchParams.get('error')).toBe(kind);
    return url;
  }

  const loginRequestId = (location: string) => {
    const returnTo = new URL(location, FULL_APP_ISSUER).searchParams.get('returnTo')!;
    return new URLSearchParams(returnTo.split('?')[1]).get('request_id')!;
  };

  /** Interactive login (seeded consent) -> code -> /token. */
  async function login(userId: string, client: Auth, resource: string, scope: string) {
    await seedConsent(full.conn, {
      userId,
      clientId: client.clientId,
      resource,
      scopes: scope.split(' '),
    });
    const verifier = randomBytes(32).toString('base64url');
    const code = await authorizeCode(full, {
      ...client,
      sessionId: await newSession(userId),
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
    return res.json<Tokens>();
  }

  const refresh = (client: Auth, rt: string) =>
    formPost(full, '/token', client, { grant_type: 'refresh_token', refresh_token: rt });
  const userinfo = (at: string) =>
    full.app.inject({
      method: 'GET',
      url: '/userinfo',
      headers: { authorization: `Bearer ${at}` },
    });
  const introspect = async (at: string) =>
    (await formPost(full, '/introspect', rs, { token: at })).json<Record<string, unknown>>();
  const adminKeys = (at: string) =>
    full.app.inject({
      method: 'GET',
      url: '/admin/keys',
      headers: { authorization: `Bearer ${at}` },
    });
  const reuseAudits = (clientId: string) =>
    auditModel.countDocuments({ action: 'TOKEN_REUSE_DETECTED', clientId });
  const refreshFailures = (clientId: string) =>
    auditModel
      .find({ action: 'TOKEN_REFRESHED', result: 'failure', clientId })
      .lean<Array<{ reason?: string }>>();
  const family = (clientId: string) =>
    rtModel
      .find({ clientId })
      .lean<Array<{ revokedAt?: Date | null; familyRevokedAt?: Date | null }>>();

  function expectInvalidGrant(res: InjectResponse) {
    expect(res.statusCode).toBe(400);
    // Opaque: the same fixed body as any garbage RT (no reason leaked).
    expect(res.json()).toEqual({
      error: 'invalid_grant',
      error_description: 'The provided grant is invalid, expired, or revoked.',
    });
    expect(res.body).not.toMatch(/access_token|refresh_token|eyJ/);
  }

  async function superAdmin(): Promise<string> {
    const userId = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
    await full.conn
      .model('UserTenant')
      .updateOne(
        { userId: new Types.ObjectId(userId), tenantId: DEFAULT_TENANT_ID },
        { $set: { roles: ['super_admin'] } },
      );
    return userId;
  }

  /** Run `hook` right after the next atomic rotate commits (race: state changes after rotate). */
  function afterNextRotate(hook: () => Promise<unknown>) {
    const svc = full.app.get(RefreshTokenService);
    const original = svc.rotate.bind(svc);
    jest.spyOn(svc, 'rotate').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      await hook();
      return result;
    });
  }

  // ---------------------------------------------------------------- F1: DEBT-123

  describe('DEBT-123: consent request_id transplanted into another session', () => {
    it('T1 B approves, then B denies (double submit), then A submits => all 400, no Location/state/code; nothing granted', async () => {
      const clientId = await mkConsentClient();
      const a = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
      const b = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
      const sa = await newSession(a);
      const sb = await newSession(b);
      const { csrf: csrfA, requestId } = await screen(clientId, sa);
      const { csrf: csrfB } = await screen(clientId, sb);
      const codes = await codeKeys();

      expectFirstPartyPage(await decide(sb, csrfB, requestId, true));
      expectFirstPartyPage(await decide(sb, csrfB, requestId, false));
      expectFirstPartyPage(await decide(sb, csrfB, requestId, true));
      expectFirstPartyPage(await decide(sa, csrfA, requestId, true)); // burned by B (single use)

      expect(await codeKeys()).toBe(codes);
      expect(await consents(a)).toBe(0);
      expect(await consents(b)).toBe(0);
      expect(await consentAudits(a)).toBe(0);
      expect(await consentAudits(b)).toBe(0);
    });

    it('T2 B denies first => 400 without the victim state; the context is burned for A', async () => {
      const clientId = await mkConsentClient();
      const a = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
      const b = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
      const sa = await newSession(a);
      const sb = await newSession(b);
      const { csrf: csrfA, requestId } = await screen(clientId, sa);
      const { csrf: csrfB } = await screen(clientId, sb);
      expectFirstPartyPage(await decide(sb, csrfB, requestId, false));
      expectFirstPartyPage(await decide(sa, csrfA, requestId, false));
      expect(await consentAudits(b)).toBe(0);
    });

    it('T3 concurrent: A approve and B approve race (x5) => B always 400; at most A gets a code, for A only', async () => {
      for (let i = 0; i < 5; i++) {
        const clientId = await mkConsentClient();
        const a = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
        const b = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
        const sa = await newSession(a);
        const sb = await newSession(b);
        const { csrf: csrfA, requestId } = await screen(clientId, sa);
        const { csrf: csrfB } = await screen(clientId, sb);
        const codes = await codeKeys();
        const [ra, rb] = await Promise.all([
          decide(sa, csrfA, requestId, true),
          decide(sb, csrfB, requestId, true),
        ]);
        expectFirstPartyPage(rb);
        if (ra.statusCode === 302) {
          expectRedirect(ra, 'code');
          expect(await codeKeys()).toBe(codes + 1);
          expect(await consents(a)).toBe(1);
        } else {
          expectFirstPartyPage(ra);
          expect(await codeKeys()).toBe(codes);
        }
        expect(await consents(b)).toBe(0);
        expect(await consentAudits(b)).toBe(0);
      }
    });

    it('T4 victim logs out (real POST /logout): B submits the request_id => 400; the victim in a NEW session => 400 too', async () => {
      const clientId = await mkConsentClient();
      const a = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
      const b = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
      const sa = await newSession(a);
      const first = await screen(clientId, sa);
      const second = await screen(clientId, sa); // a second, untouched context of A's session
      const out = await full.app.inject({
        method: 'POST',
        url: '/logout',
        cookies: { [SESSION_COOKIE]: sa },
        payload: { _csrf: first.csrf },
      });
      expect(out.statusCode).toBe(302);
      expect(await full.app.get(SessionService).get(sa)).toBeNull();

      const sb = await newSession(b);
      const { csrf: csrfB } = await screen(clientId, sb);
      expectFirstPartyPage(await decide(sb, csrfB, first.requestId, true));

      // Same user, new session (re-login): the binding is per session, not per user.
      const sa2 = await newSession(a);
      const { csrf: csrfA2 } = await screen(clientId, sa2);
      const codes = await codeKeys();
      expectFirstPartyPage(await decide(sa2, csrfA2, second.requestId, true));
      expect(await codeKeys()).toBe(codes);
      expect(await consents(a)).toBe(0);
      expect(await consents(b)).toBe(0);
    });

    it('T5 same user, two live sessions: session 2 cannot decide the screen of session 1', async () => {
      const clientId = await mkConsentClient();
      const a = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
      const s1 = await newSession(a);
      const s2 = await newSession(a);
      const { requestId } = await screen(clientId, s1);
      const { csrf: csrf2 } = await screen(clientId, s2);
      expectFirstPartyPage(await decide(s2, csrf2, requestId, false));
      expect(await consentAudits(a)).toBe(0);
    });

    it("T6 B with A's CSRF token (no session match) => 403 CSRF, context NOT burned: A still approves", async () => {
      const clientId = await mkConsentClient();
      const a = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
      const b = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
      const sa = await newSession(a);
      const sb = await newSession(b);
      const { csrf: csrfA, requestId } = await screen(clientId, sa);
      const forged = await decide(sb, csrfA, requestId, true);
      expect(forged.statusCode).toBe(403);
      expect(forged.headers['location']).toBeUndefined();
      expectRedirect(await decide(sa, csrfA, requestId, true), 'code');
      expect(await consents(b)).toBe(0);
    });

    it('control: the opening session approves => 302 code + state; denies => 302 access_denied + state + iss', async () => {
      const clientId = await mkConsentClient();
      const a = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
      const sa = await newSession(a);
      const d = await screen(clientId, sa);
      expectRedirect(await decide(sa, d.csrf, d.requestId, false), 'access_denied');
      const ok = await screen(clientId, sa);
      expectRedirect(await decide(sa, ok.csrf, ok.requestId, true), 'code');
      expect(await consents(a)).toBe(1);
    });
  });

  // ---------------------------------------------------------------- F1: DEBT-130

  describe('DEBT-130: no redirect to a redirect_uri / client that is no longer trusted', () => {
    const dropUri = (clientId: string) =>
      clientModel.updateOne({ clientId }, { $set: { redirectUris: [OTHER_REDIRECT] } });
    const disable = (clientId: string) =>
      clientModel.updateOne({ clientId }, { $set: { disabledAt: new Date() } });

    it.each([
      ['redirect_uri removed', dropUri],
      ['client disabled', disable],
    ])('deny after %s => 400 page, no Location, no denied audit', async (_label, mutate) => {
      const clientId = await mkConsentClient();
      const a = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
      const sa = await newSession(a);
      const { csrf, requestId } = await screen(clientId, sa);
      await mutate(clientId);
      expectFirstPartyPage(await decide(sa, csrf, requestId, false));
      expect(await consentAudits(a)).toBe(0);
    });

    it.each([
      ['redirect_uri removed', dropUri],
      ['client disabled', disable],
    ])('approve after %s => 400 page, no code', async (_label, mutate) => {
      const clientId = await mkConsentClient();
      const a = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
      const sa = await newSession(a);
      const { csrf, requestId } = await screen(clientId, sa);
      const codes = await codeKeys();
      await mutate(clientId);
      expectFirstPartyPage(await decide(sa, csrf, requestId, true));
      expect(await codeKeys()).toBe(codes);
    });

    /** `prompt=login&max_age=0` with a live session => 302 to /login with a reauth context. */
    async function stepUp(clientId: string, sessionId: string): Promise<string> {
      const res = await full.app.inject({
        method: 'GET',
        url: authorizeUrl(clientId, '&prompt=login&max_age=0'),
        cookies: { [SESSION_COOKIE]: sessionId },
      });
      expect(res.statusCode).toBe(302);
      return loginRequestId(String(res.headers['location']));
    }
    const resume = (rid: string, sessionId?: string) =>
      full.app.inject({
        method: 'GET',
        url: `/authorize?request_id=${encodeURIComponent(rid)}`,
        ...(sessionId ? { cookies: { [SESSION_COOKIE]: sessionId } } : {}),
      }) as Promise<InjectResponse>;

    it('step-up prompt=login&max_age=0, resume with the OLD session: URI registered => 302 login_required + state; URI removed => 400; client disabled => 400', async () => {
      const clientId = await mkConsentClient();
      const a = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
      const sa = await newSession(a);
      expectRedirect(await resume(await stepUp(clientId, sa), sa), 'login_required');

      const rid = await stepUp(clientId, sa);
      await dropUri(clientId);
      expectFirstPartyPage(await resume(rid, sa));

      const c2 = await mkConsentClient();
      const rid2 = await stepUp(c2, sa);
      await disable(c2);
      expectFirstPartyPage(await resume(rid2, sa));
    });

    it('step-up resume with NO session (user signed out meanwhile): URI registered => 302 login_required; URI removed => 400', async () => {
      const clientId = await mkConsentClient();
      const a = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
      const sa = await newSession(a);
      expectRedirect(await resume(await stepUp(clientId, sa)), 'login_required');
      const rid = await stepUp(clientId, sa);
      await dropUri(clientId);
      expectFirstPartyPage(await resume(rid));
    });
  });

  // ---------------------------------------------------------------- F2: DEBT-177

  describe.each([
    ['{public,none}', { clientType: 'public', tokenEndpointAuthMethod: 'none' }],
    ['{confidential,none}', { clientType: 'confidential', tokenEndpointAuthMethod: 'none' }],
  ])('DEBT-177: admin-capable client downgraded to %s', (_label, misfit) => {
    it("aud=admin AT dead at /userinfo (401), /introspect (active:false), admin API (401); the same client's api AT stays live; restoring revives", async () => {
      const client = await mkConfidential(
        ['api', 'admin'],
        ['openid', 'offline_access', 'api.read', 'admin.read', 'admin.write'],
      );
      const user = await superAdmin();
      const adminAt = (await login(user, client, FLOW_ADMIN_AUD, ADMIN_SCOPE)).access_token;
      const apiAt = (await login(user, client, FLOW_API_AUD, API_SCOPE)).access_token;

      // Control while capable.
      expect((await userinfo(adminAt)).statusCode).toBe(200);
      expect(await introspect(adminAt)).toMatchObject({ active: true, aud: FLOW_ADMIN_AUD });
      expect((await adminKeys(adminAt)).statusCode).toBe(200);

      await clientModel.updateOne({ clientId: client.clientId }, { $set: misfit });

      const ui = await userinfo(adminAt);
      expect(ui.statusCode).toBe(401);
      expect(String(ui.headers['www-authenticate'])).toContain('invalid_token');
      expect(ui.body).not.toMatch(/admin-capable|clientType|tokenEndpointAuthMethod/i);
      expect(await introspect(adminAt)).toEqual({ active: false });
      const adm = await adminKeys(adminAt);
      expect(adm.statusCode).toBe(401);
      expect(adm.body).not.toMatch(/"kid"|"kty"/);

      // Ordinary audience of the same (downgraded) client is not collateral damage.
      expect((await userinfo(apiAt)).statusCode).toBe(200);
      expect(await introspect(apiAt)).toMatchObject({ active: true, aud: FLOW_API_AUD });

      await clientModel.updateOne(
        { clientId: client.clientId },
        { $set: { clientType: 'confidential', tokenEndpointAuthMethod: 'client_secret_basic' } },
      );
      expect((await userinfo(adminAt)).statusCode).toBe(200);
      expect(await introspect(adminAt)).toMatchObject({ active: true });
    });
  });

  // ---------------------------------------------------------------- F3: DEBT-216

  describe('DEBT-216: refresh only while the family resource is still allowed', () => {
    it('plain: api removed from allowedResources before the refresh => invalid_grant (no token), replay invalid_grant, 0 reuse', async () => {
      const client = await mkConfidential(['api'], ['openid', 'offline_access', 'api.read']);
      const user = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
      const { refresh_token: rt } = await login(user, client, FLOW_API_AUD, API_SCOPE);
      await clientModel.updateOne(
        { clientId: client.clientId },
        { $set: { allowedResources: [] } },
      );
      expectInvalidGrant(await refresh(client, rt));
      expectInvalidGrant(await refresh(client, rt));
      expect(await reuseAudits(client.clientId)).toBe(0);
    });

    it('race: api removed right after the rotate commits => invalid_grant, family revoked, reason resource_not_allowed; replay (even after restoring api) invalid_grant, 0 reuse', async () => {
      const client = await mkConfidential(['api'], ['openid', 'offline_access', 'api.read']);
      const user = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
      const { refresh_token: rt } = await login(user, client, FLOW_API_AUD, API_SCOPE);
      afterNextRotate(() =>
        clientModel.updateOne({ clientId: client.clientId }, { $set: { allowedResources: [] } }),
      );
      expectInvalidGrant(await refresh(client, rt));
      const docs = await family(client.clientId);
      expect(docs).toHaveLength(2);
      expect(docs.every((d) => d.revokedAt && d.familyRevokedAt)).toBe(true);
      expect((await refreshFailures(client.clientId)).map((a) => a.reason)).toEqual([
        'resource_not_allowed',
      ]);

      expectInvalidGrant(await refresh(client, rt));
      await clientModel.updateOne(
        { clientId: client.clientId },
        { $set: { allowedResources: ['api'] } },
      );
      expectInvalidGrant(await refresh(client, rt));
      expect(await reuseAudits(client.clientId)).toBe(0);
    });

    it('race control: ANOTHER resource removed right after rotate => 200, the new RT works', async () => {
      const client = await mkConfidential(
        ['api', 'other'],
        ['openid', 'offline_access', 'api.read'],
      );
      const user = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
      const { refresh_token: rt } = await login(user, client, FLOW_API_AUD, API_SCOPE);
      afterNextRotate(() =>
        clientModel.updateOne(
          { clientId: client.clientId },
          { $set: { allowedResources: ['api'] } },
        ),
      );
      const ok = await refresh(client, rt);
      expect(ok.statusCode).toBe(200);
      const next = ok.json<Tokens>().refresh_token;
      expect((await refresh(client, next)).statusCode).toBe(200);
    });

    it.each([
      ['{confidential,none}', { tokenEndpointAuthMethod: 'none' }],
      ['admin removed from allowedResources', { allowedResources: ['api'] }],
    ])(
      'admin variant, %s right after rotate => invalid_grant resource_not_allowed; restore capable, replay => invalid_grant, 0 reuse; family stays dead',
      async (_label, change) => {
        const client = await mkConfidential(
          ['api', 'admin'],
          ['openid', 'offline_access', 'api.read', 'admin.read', 'admin.write'],
        );
        const user = await superAdmin();
        const { refresh_token: rt } = await login(user, client, FLOW_ADMIN_AUD, ADMIN_SCOPE);
        afterNextRotate(() =>
          clientModel.updateOne({ clientId: client.clientId }, { $set: change }),
        );
        expectInvalidGrant(await refresh(client, rt));
        expect((await refreshFailures(client.clientId)).map((a) => a.reason)).toEqual([
          'resource_not_allowed',
        ]);

        await clientModel.updateOne(
          { clientId: client.clientId },
          {
            $set: {
              tokenEndpointAuthMethod: 'client_secret_basic',
              allowedResources: ['api', 'admin'],
            },
          },
        );
        expectInvalidGrant(await refresh(client, rt));
        expect(await reuseAudits(client.clientId)).toBe(0);
        const docs = await family(client.clientId);
        expect(docs.every((d) => d.revokedAt && d.familyRevokedAt)).toBe(true);
      },
    );
  });

  // ---------------------------------------------------------------- exposure

  describe('exposure (runs last)', () => {
    // `SESSION_REVOKED.targetId` = session ref by design (pre-run-55, a public sha256 id; the
    // logout in T4 writes one): excluded from the ref check only, never from the JWT/id check.
    it('no JWT or session id anywhere; no session ref in the app log or in OAuth audit documents', async () => {
      const all = JSON.stringify(await auditModel.find({}).lean());
      const oauth = JSON.stringify(
        await auditModel.find({ action: { $ne: 'SESSION_REVOKED' } }).lean(),
      );
      const log = pino.join('\n');
      expect(pino.length).toBeGreaterThan(0);
      expect(sessionIds.length).toBeGreaterThan(10);
      for (const sink of [all, log]) {
        expect(JWT.test(sink)).toBe(false);
        expect(sessionIds.filter((id) => sink.includes(id))).toEqual([]);
      }
      for (const sink of [oauth, log]) {
        expect(sessionIds.filter((id) => sink.includes(sha256(id)))).toEqual([]);
      }
    });
  });
});
