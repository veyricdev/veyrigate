import { randomBytes } from 'node:crypto';
import { deriveS256Challenge } from '../src/common/crypto/pkce.util';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { SESSION_COOKIE } from '../src/modules/sessions/session.cookie';
import { SessionService } from '../src/modules/sessions/session.service';
import { ANON_COOKIE } from '../src/modules/ui/csrf.service';
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
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';
import { seedConsent, seedOAuthUser } from './oauth-fixtures';

/**
 * Run 92 lot C (T7, CodeQL triage) on the REAL app:
 * - #31/#32 `LogoutCsrfGuard`: a POST `/logout` with a live session cookie and NO `_csrf` only renders
 *   the confirmation; the session survives (next request), and the rendered form then ends it.
 * - #9 logout `state`: a repeated query param (array) is treated as absent, never joined into the
 *   redirect; other repeated logout params never 5xx.
 * - #7 `findByClientId`: an operator-shaped `client_id` never yields a token.
 * - #16 `/authorize`: a missing/malformed `code_challenge` is `invalid_request`, no code.
 */
const POST_LOGOUT = 'https://app.example.com/after-logout';
const SCOPE = 'openid api.read';

const setCookies = (res: InjectResponse): string[] =>
  ([] as string[]).concat((res.headers['set-cookie'] as string | string[] | undefined) ?? []);
const hidden = (body: string, name: string): string | undefined =>
  new RegExp(`name="${name}" value="([^"]*)"`).exec(body)?.[1];

describe('run 92 lot C: CodeQL triage negative tests', () => {
  let full: FullApp;
  let client: { clientId: string; secret: string };
  let userId = '';

  let setup: Promise<void> | undefined;
  beforeAll(
    () =>
      (setup = (async () => {
        full = await bootFullApp({ name: 'run92c' });
        client = await seedFlowClient(full);
        await full.conn
          .model('Client')
          .updateOne(
            { clientId: client.clientId },
            { $set: { postLogoutRedirectUris: [POST_LOGOUT] } },
          );
        userId = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
        await seedConsent(full.conn, {
          userId,
          clientId: client.clientId,
          resource: FLOW_API_AUD,
          scopes: SCOPE.split(' '),
        });
      })()),
    INT_SETUP_TIMEOUT_MS,
  );
  afterAll(async () => {
    await settled(setup);
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);

  const newSession = async () =>
    (await full.app.get(SessionService).create(userId, DEFAULT_TENANT_ID)).id;
  const sessionAlive = async (id: string) => (await full.app.get(SessionService).get(id)) !== null;
  const idToken = async (sid: string): Promise<string> => {
    const verifier = randomBytes(32).toString('base64url');
    const code = await authorizeCode(full, {
      ...client,
      sessionId: sid,
      resource: FLOW_API_AUD,
      scope: SCOPE,
      verifier,
    });
    const res = await formPost(full, '/token', client, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: FLOW_REDIRECT,
      code_verifier: verifier,
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ id_token: string }>().id_token;
  };
  /** Submit a rendered logout form (its hidden fields + `_csrf`) with the given cookies. */
  const submitLogoutForm = (page: InjectResponse, cookies: Record<string, string>) => {
    const body = new URLSearchParams();
    for (const name of [
      '_csrf',
      'id_token_hint',
      'post_logout_redirect_uri',
      'state',
      'client_id',
    ]) {
      const v = hidden(page.body, name);
      if (v !== undefined) body.append(name, v.replaceAll('&amp;', '&'));
    }
    return full.app.inject({
      method: 'POST',
      url: '/logout',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      cookies,
      payload: body.toString(),
    }) as Promise<InjectResponse>;
  };

  describe('#31/#32 POST /logout without _csrf never ends the session', () => {
    it('urlencoded RP params + live session cookie, no _csrf => 200 confirmation, cookie kept, session alive; the rendered form then ends it', async () => {
      const sid = await newSession();
      const page = (await full.app.inject({
        method: 'POST',
        url: '/logout',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        cookies: { [SESSION_COOKIE]: sid },
        payload: new URLSearchParams({ client_id: client.clientId, state: 'st' }).toString(),
      })) as InjectResponse;
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('<form method="post" action="/logout">');
      expect(setCookies(page).some((c) => c.startsWith(`${SESSION_COOKIE}=;`))).toBe(false);
      expect(await sessionAlive(sid)).toBe(true);

      // Next request with the same cookie jar: the session is still the caller's identity.
      const anon = setCookies(page).find((c) => c.startsWith(`${ANON_COOKIE}=`));
      const cookies: Record<string, string> = { [SESSION_COOKIE]: sid };
      if (anon) cookies[ANON_COOKIE] = anon.split(';')[0].slice(ANON_COOKIE.length + 1);
      const done = await submitLogoutForm(page, cookies);
      expect(done.statusCode).toBe(303);
      expect(await sessionAlive(sid)).toBe(false);
    });

    it('empty urlencoded body with a live session => 200 confirmation, session alive', async () => {
      const sid = await newSession();
      const res = (await full.app.inject({
        method: 'POST',
        url: '/logout',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        cookies: { [SESSION_COOKIE]: sid },
        payload: '',
      })) as InjectResponse;
      expect(res.statusCode).toBe(200);
      expect(await sessionAlive(sid)).toBe(true);
    });
  });

  describe('#9 GET /logout with repeated parameters', () => {
    it('?state=a&state=b with a valid hint + registered URI => no state field; the form redirects to the URI WITHOUT state', async () => {
      const sid = await newSession();
      const hint = await idToken(sid);
      const qs = new URLSearchParams([
        ['id_token_hint', hint],
        ['post_logout_redirect_uri', POST_LOGOUT],
        ['state', 'a'],
        ['state', 'b'],
      ]);
      const page = (await full.app.inject({
        method: 'GET',
        url: `/logout?${qs.toString()}`,
        cookies: { [SESSION_COOKIE]: sid },
      })) as InjectResponse;
      expect(page.statusCode).toBe(200);
      expect(hidden(page.body, 'post_logout_redirect_uri')).toBe(POST_LOGOUT);
      expect(page.body).not.toContain('name="state"');
      expect(page.body).not.toContain('a,b');

      const anon = setCookies(page).find((c) => c.startsWith(`${ANON_COOKIE}=`));
      const cookies: Record<string, string> = { [SESSION_COOKIE]: sid };
      if (anon) cookies[ANON_COOKIE] = anon.split(';')[0].slice(ANON_COOKIE.length + 1);
      const done = await submitLogoutForm(page, cookies);
      expect(done.statusCode).toBe(303);
      expect(done.headers['location']).toBe(POST_LOGOUT);
      expect(await sessionAlive(sid)).toBe(false);
    });

    it('control: a single state is reflected and appended', async () => {
      const sid = await newSession();
      const hint = await idToken(sid);
      const page = (await full.app.inject({
        method: 'GET',
        url: `/logout?${new URLSearchParams({ id_token_hint: hint, post_logout_redirect_uri: POST_LOGOUT, state: 'st' }).toString()}`,
      })) as InjectResponse;
      expect(page.statusCode).toBe(200);
      expect(hidden(page.body, 'state')).toBe('st');
    });

    it.each(['id_token_hint', 'post_logout_redirect_uri', 'client_id'])(
      'repeated %s => 200 confirmation (never 5xx), the RP URI is not reflected, session alive',
      async (name) => {
        const sid = await newSession();
        const hint = await idToken(sid);
        const fields: Record<string, string> = {
          id_token_hint: hint,
          post_logout_redirect_uri: POST_LOGOUT,
          client_id: client.clientId,
        };
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(fields)) {
          qs.append(k, v);
          if (k === name) qs.append(k, v);
        }
        const page = (await full.app.inject({
          method: 'GET',
          url: `/logout?${qs.toString()}`,
          cookies: { [SESSION_COOKIE]: sid },
        })) as InjectResponse;
        expect(page.statusCode).toBe(200);
        if (name !== 'client_id') {
          expect(page.body).not.toContain('name="post_logout_redirect_uri"');
        }
        expect(await sessionAlive(sid)).toBe(true);
      },
    );
  });

  describe('#7 operator-shaped client_id at /token', () => {
    it.each<[string, string, string]>([
      [
        'urlencoded client_id[$ne]',
        'application/x-www-form-urlencoded',
        'grant_type=client_credentials&client_id%5B%24ne%5D=x&client_secret=x',
      ],
      [
        'JSON client_id {$ne:null}',
        'application/json',
        JSON.stringify({
          grant_type: 'client_credentials',
          client_id: { $ne: null },
          client_secret: 'x',
        }),
      ],
    ])('%s => 4xx, no token', async (_n, type, payload) => {
      const res = (await full.app.inject({
        method: 'POST',
        url: '/token',
        headers: { 'content-type': type },
        payload,
      })) as InjectResponse;
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
      expect(res.body).not.toContain('access_token');
    });
  });

  describe('#16 /authorize code_challenge', () => {
    const authorize = async (challenge: string | undefined) => {
      const qs = new URLSearchParams([
        ['response_type', 'code'],
        ['client_id', client.clientId],
        ['redirect_uri', FLOW_REDIRECT],
        ['scope', SCOPE],
        ['resource', FLOW_API_AUD],
        ['state', 'st'],
        ['code_challenge_method', 'S256'],
      ]);
      if (challenge !== undefined) qs.append('code_challenge', challenge);
      return (await full.app.inject({
        method: 'GET',
        url: `/authorize?${qs.toString()}`,
        cookies: { [SESSION_COOKIE]: await newSession() },
      })) as InjectResponse;
    };

    it.each<[string, string | undefined]>([
      ['missing', undefined],
      ['empty', ''],
      ['too short', 'abc'],
      ['bad alphabet', `${'a'.repeat(42)}!`],
    ])('%s => 302 invalid_request, no code', async (_n, challenge) => {
      const res = await authorize(challenge);
      expect(res.statusCode).toBe(302);
      const loc = new URL(String(res.headers['location']));
      expect(`${loc.origin}${loc.pathname}`).toBe(FLOW_REDIRECT);
      expect(loc.searchParams.get('error')).toBe('invalid_request');
      expect(loc.searchParams.get('code')).toBeNull();
    });

    it('control: a valid S256 challenge issues a code', async () => {
      const res = await authorize(deriveS256Challenge(randomBytes(32).toString('base64url')));
      expect(res.statusCode).toBe(302);
      expect(new URL(String(res.headers['location'])).searchParams.get('code')).toBeTruthy();
    });
  });
});
