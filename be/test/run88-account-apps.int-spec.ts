import { jest } from '@jest/globals';
import { randomBytes, randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { deriveS256Challenge } from '../src/common/crypto/pkce.util';
import { ClientCredentialService } from '../src/modules/clients/client-credential.service';
import { ClientService } from '../src/modules/clients/client.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { UserService } from '../src/modules/identity/user.service';
import { RefreshTokenService } from '../src/modules/oauth/token/refresh-token.service';
import { AuditAction } from '../src/modules/security/audit/audit-action.enum';
import {
  bootFullApp,
  FLOW_API_AUD,
  FLOW_REDIRECT,
  formPost,
  seedFlowClient,
  type FullApp,
  type InjectResponse,
} from './full-app';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';

/**
 * Run 88 T3 (C-10.7b, DEBT-581, D88.21–D88.22) on the REAL app over HTTP: the consent screen shows
 * the origin of the registered redirect URI, OIDC scope descriptions and lifetimes taken from config;
 * `/account/apps` lists the user's own active consents and revokes one (consent first, then its
 * refresh families, idempotent with a re-sweep), never another user's.
 */
const PASSWORD = 'r88a-Current#Pass-1';
const SCOPE = 'openid email offline_access api.read';

const setCookies = (res: InjectResponse): string[] =>
  ([] as string[]).concat((res.headers['set-cookie'] as string | string[] | undefined) ?? []);
const pairOf = (res: InjectResponse, name: string) =>
  setCookies(res)
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0];
const csrfOf = (res: InjectResponse): string => res.body.match(/name="_csrf" value="([^"]+)"/)![1];

const suite = (name: string, env: Record<string, string>, minutes: number, days: number) =>
  describe(`run 88 T3: consent screen + /account/apps (${name})`, () => {
    let full: FullApp;
    let c1: { clientId: string; secret: string };
    let c2: { clientId: string; secret: string };
    let noRefresh: { clientId: string; secret: string };

    const confidential = async (grantTypes: string[]) => {
      const clientId = `r88a-${randomUUID()}`;
      await full.app.get(ClientService).create({
        clientId,
        clientType: 'confidential',
        tokenEndpointAuthMethod: 'client_secret_basic',
        redirectUris: [FLOW_REDIRECT],
        allowedResources: ['api'],
        scopes: ['openid', 'email', 'offline_access', 'api.read'],
        grantTypes,
        tenantId: DEFAULT_TENANT_ID,
      } as never);
      const { secret } = await full.app.get(ClientCredentialService).createSecret(clientId);
      return { clientId, secret };
    };
    const boot = async (): Promise<void> => {
      full = await bootFullApp({ name: `run88-apps-${name.replace(/[^a-z0-9]+/gi, '-')}`, env });
      c1 = await seedFlowClient(full);
      c2 = await confidential(['authorization_code', 'refresh_token']);
      noRefresh = await confidential(['authorization_code']);
    };
    let setup: Promise<void> | undefined;
    beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS);
    afterAll(async () => {
      await settled(setup);
      await full?.close();
    }, INT_SETUP_TIMEOUT_MS);
    afterEach(() => jest.restoreAllMocks());

    const newUser = async () => {
      const email = `r88a-${randomUUID()}@fixture.test`;
      const users = full.app.get(UserService);
      const u = await users.create({ email, password: PASSWORD });
      await users.verifyEmail(u.sub);
      await full.conn.model('UserTenant').create({
        userId: new Types.ObjectId(u.sub),
        tenantId: DEFAULT_TENANT_ID,
        status: 'active',
      });
      return { email, sub: u.sub };
    };
    const login = async (email: string) => {
      // One network per sign-in: the per-IP `/login` limiter is not what this spec tests.
      const remoteAddress = `198.51.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
      const page = (await full.app.inject({
        method: 'GET',
        url: '/login',
        remoteAddress,
      })) as InjectResponse;
      const res = (await full.app.inject({
        method: 'POST',
        url: '/login',
        remoteAddress,
        headers: { cookie: pairOf(page, 'idp_csrf')! },
        payload: { _csrf: csrfOf(page), email, password: PASSWORD, returnTo: '/' },
      })) as InjectResponse;
      return pairOf(res, 'idp_session')!;
    };
    const authorize = (jar: string, clientId: string, scope = SCOPE, verifier = 'v'.repeat(43)) =>
      full.app.inject({
        method: 'GET',
        url: `/authorize?${new URLSearchParams({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: FLOW_REDIRECT,
          scope,
          resource: FLOW_API_AUD,
          state: 's',
          nonce: 'n',
          code_challenge: deriveS256Challenge(verifier),
          code_challenge_method: 'S256',
        }).toString()}`,
        headers: { cookie: jar },
      }) as Promise<InjectResponse>;
    /** Consent through the real screen, then the code exchange => tokens of that client. */
    const consentAndTokens = async (jar: string, client: { clientId: string; secret: string }) => {
      const verifier = randomBytes(32).toString('base64url');
      const screen = await authorize(jar, client.clientId, SCOPE, verifier);
      expect(screen.statusCode).toBe(200);
      const requestId = screen.body.match(/name="request_id" value="([^"]+)"/)![1];
      const approved = await full.app.inject({
        method: 'POST',
        url: '/authorize/consent',
        headers: { cookie: jar },
        payload: { _csrf: csrfOf(screen), request_id: requestId, approve: 'true' },
      });
      const code = new URL(String(approved.headers['location'])).searchParams.get('code')!;
      return (
        await formPost(full, '/token', client, {
          grant_type: 'authorization_code',
          code,
          redirect_uri: FLOW_REDIRECT,
          code_verifier: verifier,
          resource: FLOW_API_AUD,
        })
      ).json<{ refresh_token: string }>();
    };
    const refresh = (client: { clientId: string; secret: string }, token: string) =>
      formPost(full, '/token', client, {
        grant_type: 'refresh_token',
        refresh_token: token,
        resource: FLOW_API_AUD,
      });
    const apps = (jar?: string) =>
      full.app.inject({
        method: 'GET',
        url: '/account/apps',
        headers: jar ? { cookie: jar } : {},
      }) as Promise<InjectResponse>;
    const sessionsPage = (jar: string) =>
      full.app.inject({
        method: 'GET',
        url: '/account/sessions',
        headers: { cookie: jar },
      }) as Promise<InjectResponse>;
    const revoke = async (jar: string, consentId: string, csrf?: string) =>
      full.app.inject({
        method: 'POST',
        url: '/account/apps/revoke',
        headers: { cookie: jar },
        // The CSRF of this session identity (an empty apps page has no form).
        payload: { _csrf: csrf ?? csrfOf(await sessionsPage(jar)), consent_id: consentId },
      }) as Promise<InjectResponse>;
    const consentId = async (sub: string, clientId: string) =>
      (await full.conn
        .collection('consents')
        .findOne({ userId: new Types.ObjectId(sub), clientId }))!._id.toHexString();
    const audits = (sub: string) =>
      full.conn
        .collection('auditlogs')
        .find({ action: AuditAction.OAUTH_CONSENT_REVOKED, actorId: sub })
        .sort({ _id: 1 })
        .toArray();
    const activeFamilies = (sub: string, clientId: string) =>
      full.conn.collection('refreshtokens').countDocuments({
        userId: new Types.ObjectId(sub),
        clientId,
        revokedAt: null,
      });

    it(`AC1/AC2 consent screen: origin, scope descriptions, "${minutes} minutes" + "${days} days" only with refresh grant AND offline_access`, async () => {
      const u = await newUser();
      const jar = await login(u.email);
      const screen = await authorize(jar, c1.clientId);
      expect(screen.statusCode).toBe(200);
      expect(screen.body).toContain(`<strong>${c1.clientId}</strong>`);
      expect(screen.body).toContain(
        'will receive the result at <strong>https://app.example.com</strong>',
      );
      expect(screen.body).toContain('Confirm your identity');
      expect(screen.body).toContain('See your email address');
      expect(screen.body).toContain('Stay signed in when you are not using it');
      expect(screen.body).toContain('<code>api.read</code>');
      expect(screen.body).toContain(`Each access lasts up to ${minutes} minutes.`);
      expect(screen.body).toContain(`up to ${days} days without you signing in again`);
      expect(screen.body).toContain('href="/account/apps"');
      expect(screen.body).toContain('name="approve" value="true"');
      expect(screen.body).toContain('name="request_id"');

      const noOffline = await authorize(jar, c1.clientId, 'openid email api.read');
      expect(noOffline.body).toContain(`Each access lasts up to ${minutes} minutes.`);
      expect(noOffline.body).not.toContain('days without you signing in again');
      const noGrant = await authorize(jar, noRefresh.clientId);
      expect(noGrant.statusCode).toBe(200);
      expect(noGrant.body).not.toContain('days without you signing in again');
    });

    if (name !== 'default TTL') return;

    it('AC1 the origin comes from the stored redirect URI, never from the query', async () => {
      const u = await newUser();
      const jar = await login(u.email);
      const res = await full.app.inject({
        method: 'GET',
        url: `/authorize?${new URLSearchParams({
          response_type: 'code',
          client_id: c1.clientId,
          redirect_uri: 'https://evil.example.net/callback',
          scope: SCOPE,
          resource: FLOW_API_AUD,
          code_challenge: deriveS256Challenge('v'.repeat(43)),
          code_challenge_method: 'S256',
        }).toString()}`,
        headers: { cookie: jar },
      });
      expect(res.body).not.toContain('evil.example.net');
      expect(res.body).not.toContain('will receive the result');
    });

    it('AC1 resumed request (/authorize?request_id after sign-in) still shows the stored origin', async () => {
      const u = await newUser();
      const first = (await full.app.inject({
        method: 'GET',
        url: `/authorize?${new URLSearchParams({
          response_type: 'code',
          client_id: c1.clientId,
          redirect_uri: FLOW_REDIRECT,
          scope: SCOPE,
          resource: FLOW_API_AUD,
          code_challenge: deriveS256Challenge('v'.repeat(43)),
          code_challenge_method: 'S256',
        }).toString()}`,
      })) as InjectResponse;
      expect(first.statusCode).toBe(302);
      const binding = setCookies(first).map((c) => c.split(';')[0]);
      const returnTo = new URL(String(first.headers['location']), 'http://x').searchParams.get(
        'returnTo',
      )!;
      const remoteAddress = '203.0.113.88';
      const page = (await full.app.inject({
        method: 'GET',
        url: '/login',
        remoteAddress,
      })) as InjectResponse;
      const signed = (await full.app.inject({
        method: 'POST',
        url: '/login',
        remoteAddress,
        headers: { cookie: [pairOf(page, 'idp_csrf')!, ...binding].join('; ') },
        payload: { _csrf: csrfOf(page), email: u.email, password: PASSWORD, returnTo },
      })) as InjectResponse;
      const resume = String(signed.headers['location']);
      expect(resume).toMatch(/^\/authorize\?request_id=/);
      const screen = (await full.app.inject({
        method: 'GET',
        url: resume,
        headers: { cookie: [pairOf(signed, 'idp_session')!, ...binding].join('; ') },
      })) as InjectResponse;
      expect(screen.statusCode).toBe(200);
      expect(screen.body).toContain(
        'will receive the result at <strong>https://app.example.com</strong>',
      );
    });

    it('AC3 /account/apps: 2 consents listed; revoked hidden; disabled / removed client labels; no session => 302', async () => {
      const u = await newUser();
      const jar = await login(u.email);
      await consentAndTokens(jar, c1);
      await consentAndTokens(jar, c2);
      const page = await apps(jar);
      expect(page.statusCode).toBe(200);
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.body).toContain(c1.clientId);
      expect(page.body).toContain(c2.clientId);
      expect(page.body).toContain(`<code>${FLOW_API_AUD}</code>`);
      expect(page.body).toContain(`<code>${SCOPE.split(' ').sort().join(' ')}</code>`);
      expect(page.body.match(/name="consent_id"/g)?.length).toBe(2);

      const gone = `r88a-gone-${randomUUID()}`;
      const off = `r88a-off-${randomUUID()}`;
      await full.conn.collection('clients').insertOne({
        clientId: off,
        clientType: 'confidential',
        tenantId: DEFAULT_TENANT_ID,
        disabledAt: new Date(),
      });
      const consents = full.conn.collection('consents');
      const base = { userId: new Types.ObjectId(u.sub), resource: '', grantedScopes: ['openid'] };
      const stamp = { grantedAt: new Date(), updatedAt: new Date() };
      await consents.insertMany([
        { ...base, clientId: gone, ...stamp, revokedAt: null },
        { ...base, clientId: off, ...stamp, revokedAt: null },
        { ...base, clientId: `r88a-revoked-${randomUUID()}`, ...stamp, revokedAt: new Date() },
      ]);
      const after = await apps(jar);
      expect(after.body).toContain('Removed application');
      expect(after.body).not.toContain(gone);
      expect(after.body).toContain(`${off}</strong> (disabled)`);
      expect(after.body).toContain('Sign-in only');
      expect(after.body).not.toContain('r88a-revoked-');

      const anon = await apps();
      expect(anon.statusCode).toBe(302);
      expect(anon.headers['location']).toBe('/login?returnTo=%2Faccount%2Fapps');
    });

    it('AC4/AC5 revoke C1 => 303, refresh of C1 invalid_grant, C2 still refreshes, /authorize asks again; retry re-sweeps', async () => {
      const u = await newUser();
      const jar = await login(u.email);
      const t1 = await consentAndTokens(jar, c1);
      const t2 = await consentAndTokens(jar, c2);
      const id = await consentId(u.sub, c1.clientId);

      const res = await revoke(jar, id);
      expect(res.statusCode).toBe(303);
      expect(res.headers['location']).toBe('/account/apps?done=revoked');
      const doc = await full.conn.collection('consents').findOne({ _id: new Types.ObjectId(id) });
      expect(doc?.revokedAt).toBeInstanceOf(Date);
      const r1 = await refresh(c1, t1.refresh_token);
      expect(r1.statusCode).toBe(400);
      expect(r1.json()).toMatchObject({ error: 'invalid_grant' });
      expect((await refresh(c2, t2.refresh_token)).statusCode).toBe(200);
      const again = await authorize(jar, c1.clientId);
      expect(again.statusCode).toBe(200);
      expect(again.body).toContain('name="approve" value="true"');
      expect((await audits(u.sub)).at(-1)).toMatchObject({
        actorType: 'user',
        result: 'success',
        clientId: c1.clientId,
        metadata: { via: 'self', alreadyRevoked: false, count: 1, resource: FLOW_API_AUD },
      });

      // AC5: a family inserted after the first revoke is swept by the retry.
      await full.conn.collection('refreshtokens').insertOne({
        tokenHash: randomUUID(),
        familyId: randomUUID(),
        userId: new Types.ObjectId(u.sub),
        clientId: c1.clientId,
        resource: FLOW_API_AUD,
        scope: ['openid'],
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      expect(await activeFamilies(u.sub, c1.clientId)).toBe(1);
      const retry = await revoke(jar, id);
      expect(retry.statusCode).toBe(303);
      expect(await activeFamilies(u.sub, c1.clientId)).toBe(0);
      expect((await audits(u.sub)).at(-1)).toMatchObject({
        metadata: { alreadyRevoked: true, count: 1, via: 'self' },
      });
      expect(
        (await full.conn.collection('consents').findOne({ _id: new Types.ObjectId(id) }))
          ?.revokedAt,
      ).toEqual(doc?.revokedAt);
    });

    it("AC6 another user's consent / unknown / malformed => fixed 404, nothing changes, id not audited", async () => {
      const u = await newUser();
      const v = await newUser();
      const jarU = await login(u.email);
      const jarV = await login(v.email);
      await consentAndTokens(jarV, c1);
      const victim = await consentId(v.sub, c1.clientId);
      const bodies: string[] = [];
      for (const id of [victim, new Types.ObjectId().toHexString(), 'zz', victim.toUpperCase()]) {
        const res = await revoke(jarU, id);
        expect(res.statusCode).toBe(404);
        bodies.push(res.body);
      }
      expect(new Set(bodies).size).toBe(1);
      expect(
        (await full.conn.collection('consents').findOne({ _id: new Types.ObjectId(victim) }))
          ?.revokedAt,
      ).toBeNull();
      const fails = await audits(u.sub);
      expect(fails.every((e) => e.result === 'failure' && e.reason === 'not_found')).toBe(true);
      expect(JSON.stringify(fails)).not.toContain(victim);
    });

    it('AC7 missing / foreign CSRF => 403, nothing changes', async () => {
      const u = await newUser();
      const v = await newUser();
      const jar = await login(u.email);
      await consentAndTokens(jar, c1);
      const id = await consentId(u.sub, c1.clientId);
      const none = await full.app.inject({
        method: 'POST',
        url: '/account/apps/revoke',
        headers: { cookie: jar },
        payload: { consent_id: id },
      });
      expect(none.statusCode).toBe(403);
      const foreign = await revoke(jar, id, csrfOf(await sessionsPage(await login(v.email))));
      expect(foreign.statusCode).toBe(403);
      expect(
        (await full.conn.collection('consents').findOne({ _id: new Types.ObjectId(id) }))
          ?.revokedAt,
      ).toBeNull();
    });

    it('AC8 sweep fault => 5xx + family_sweep_failed (consent already revoked); retry => 303, family revoked', async () => {
      const u = await newUser();
      const jar = await login(u.email);
      await consentAndTokens(jar, c1);
      const id = await consentId(u.sub, c1.clientId);
      jest
        .spyOn(full.app.get(RefreshTokenService), 'revokeForConsent')
        .mockRejectedValueOnce(new Error('mongodb://u:r88a-S3CRET@h down'));
      const res = await revoke(jar, id);
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(res.body).not.toContain('r88a-S3CRET');
      expect((await audits(u.sub)).at(-1)).toMatchObject({
        result: 'failure',
        reason: 'family_sweep_failed',
      });
      expect(await activeFamilies(u.sub, c1.clientId)).toBe(1);
      jest.restoreAllMocks();
      expect((await revoke(jar, id)).statusCode).toBe(303);
      expect(await activeFamilies(u.sub, c1.clientId)).toBe(0);
    });

    it('AC9 hostile clientId / scope / resource stored in the DB are escaped on /account/apps and the consent screen', async () => {
      const u = await newUser();
      const jar = await login(u.email);
      const evil = '<script>alert(1)</script>';
      await full.conn.collection('consents').insertOne({
        userId: new Types.ObjectId(u.sub),
        clientId: evil,
        resource: '<img src=x onerror=alert(2)>',
        grantedScopes: ['<b>x</b>'],
        grantedAt: new Date(),
        updatedAt: new Date(),
        revokedAt: null,
      });
      await full.conn
        .collection('clients')
        .insertOne({ clientId: evil, tenantId: DEFAULT_TENANT_ID });
      const page = await apps(jar);
      expect(page.body).not.toContain('<script>alert(1)</script>');
      expect(page.body).not.toContain('<img src=x');
      expect(page.body).not.toContain('<b>x</b>');
      expect(page.body).toContain('&lt;script&gt;');

      const xssClient = `<i>r88a-${randomUUID()}</i>`;
      await full.app.get(ClientService).create({
        clientId: xssClient,
        clientType: 'confidential',
        tokenEndpointAuthMethod: 'client_secret_basic',
        redirectUris: [FLOW_REDIRECT],
        allowedResources: ['api'],
        scopes: ['openid', 'api.read'],
        grantTypes: ['authorization_code'],
        tenantId: DEFAULT_TENANT_ID,
      } as never);
      const screen = await authorize(jar, xssClient, 'openid api.read');
      expect(screen.statusCode).toBe(200);
      expect(screen.body).not.toContain(xssClient);
      expect(screen.body).toContain('&lt;i&gt;r88a-');
    });
  });

suite('default TTL', {}, 15, 30);
suite('TTL from env', { ACCESS_TOKEN_TTL: '600', REFRESH_TOKEN_TTL: '86400' }, 10, 1);
