import { jest } from '@jest/globals';
import { decodeProtectedHeader } from 'jose';
import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { buildCsp } from '../src/common/http/csp';
import { hashPassword } from '../src/common/crypto/crypto.util';
import { validateEnv } from '../src/config/validation.schema';
import { AuthenticationService } from '../src/modules/authentication/authentication.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { UserService } from '../src/modules/identity/user.service';
import { UserTenantService } from '../src/modules/identity/user-tenant.service';
import { KEY_PROVIDER, RotationPendingError } from '../src/modules/keys/key-provider';
import { LocalKeyProvider } from '../src/modules/keys/local-key-provider';
import { SESSION_COOKIE } from '../src/modules/sessions/session.cookie';
import { SessionService } from '../src/modules/sessions/session.service';
import { ANON_COOKIE, CsrfService } from '../src/modules/ui/csrf.service';
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
import { tokenFromMailLink } from './helpers/mail-token';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';
import { seedConsent } from './oauth-fixtures';

/**
 * Run 86 tester (T6) — edges the T1/T2/T4 dev specs do not cover, on the REAL app:
 * - F*: `/assets/token-fragment.js` executed (node:vm, fake DOM) on hostile/odd fragments; rendered
 *   pages have no inline script and never reflect a token from the query, Referer or a failed POST;
 *   pasted codes with zero-width / homoglyph characters are rejected WITHOUT consuming the token,
 *   while `String#trim` whitespace (NBSP, U+3000, BOM) is accepted.
 * - L*: POST `/logout` with a repeated/typed `_csrf`, JSON/text bodies, near-miss
 *   `post_logout_redirect_uri` values through POST with a REAL id_token_hint, and (secure mode) a
 *   tossed non-`__Host-` anonymous/session cookie.
 * - K*: KEY_PREPUBLISH_SEC boundaries through the real boot and factory; the pending key never signs
 *   across many tokens (provider + real /token); rotate → 409 → emergency → normal → 409; concurrent
 *   normal/emergency mix; legacy `keys.json` whose `status` fields contradict the derived state.
 */
const PASSWORD = 'r86t-tester-password-1'; // throwaway int DB user
const NEW_PASSWORD = 'r86t-brand-new-password-2';
const SCOPE = 'openid offline_access api.read';
const POST_LOGOUT = 'https://app.example.com/after-logout';
const MARK = 'R86TMARKtokenMUSTneverBEreflectedANYWHERExx'; // 43 chars, base64url alphabet
const TTL = 900;

const setCookies = (res: InjectResponse): string[] =>
  ([] as string[]).concat((res.headers['set-cookie'] as string | string[] | undefined) ?? []);
const allHeaders = (res: InjectResponse): string => JSON.stringify(res.headers);

/** Shared seeding of a confidential RP + a verified user with consent (code flow ready). */
async function seedRp(full: FullApp) {
  const client = await seedFlowClient(full);
  await full.conn
    .model('Client')
    .updateOne({ clientId: client.clientId }, { $set: { postLogoutRedirectUris: [POST_LOGOUT] } });
  const email = `r86t-${randomUUID()}@fixture.test`;
  const users = full.app.get(UserService);
  const user = await users.createWithPasswordHash(email, await hashPassword(PASSWORD));
  await users.verifyEmail(user.sub);
  await full.app
    .get(UserTenantService)
    .addMembership(user.sub, DEFAULT_TENANT_ID, ['tenant_admin']);
  await seedConsent(full.conn, {
    userId: user.sub,
    clientId: client.clientId,
    resource: FLOW_API_AUD,
    scopes: SCOPE.split(' '),
  });
  return { client, userId: user.sub };
}

async function issueTokens(
  full: FullApp,
  client: { clientId: string; secret: string },
  sessionId: string,
): Promise<{ access_token: string; id_token: string }> {
  const verifier = randomBytes(32).toString('base64url');
  const code = await authorizeCode(full, {
    ...client,
    sessionId,
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
  return res.json();
}

// ---------------------------------------------------------------------------------------------
// F1: the fragment script itself, executed in node:vm with a minimal fake DOM.
// ---------------------------------------------------------------------------------------------
type FakeEl = { value: string; hidden: boolean };
function runFragmentScript(
  src: string,
  hash: string,
  opts: { field?: boolean; label?: boolean } = {},
) {
  const field: FakeEl = { value: '', hidden: false };
  const label: FakeEl = { value: '', hidden: false };
  const replaceState = jest.fn();
  const els: Record<string, FakeEl | null> = {
    token: opts.field === false ? null : field,
    'token-manual': opts.label === false ? null : label,
  };
  const window = {
    location: { hash, pathname: '/reset', search: '?token=fromquery' },
    history: { replaceState },
  };
  const document = { getElementById: (id: string) => els[id] ?? null };
  vm.runInNewContext(src, { window, document });
  return { field, label, replaceState };
}

describe('run 86 tester (T6): token fragment, POST /logout, key pre-publish edges', () => {
  // ------------------------------------------------------------------------------------------
  // Main app: non-secure cookies, KEY_PREPUBLISH_SEC at the upper bound (86400).
  // ------------------------------------------------------------------------------------------
  describe('main app (KEY_PREPUBLISH_SEC=86400, non-secure cookies)', () => {
    let full: FullApp;
    let client: { clientId: string; secret: string };
    let userId = '';
    let csrf: CsrfService;
    let script = '';

    const boot = async (): Promise<void> => {
      full = await bootFullApp({ name: 'run86-tester', env: { KEY_PREPUBLISH_SEC: '86400' } });
      ({ client, userId } = await seedRp(full));
      csrf = full.app.get(CsrfService);
      script = (await full.app.inject({ method: 'GET', url: '/assets/token-fragment.js' })).body;
    };
    let setup: Promise<void> | undefined;
    beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS);
    afterAll(async () => {
      await settled(setup);
      await full?.close();
    }, INT_SETUP_TIMEOUT_MS);

    const get = (url: string, headers: Record<string, string> = {}) =>
      full.app.inject({ method: 'GET', url, headers }) as Promise<InjectResponse>;
    const flushMail = () => new Promise((resolve) => setImmediate(resolve));
    const newSession = async () =>
      (await full.app.get(SessionService).create(userId, DEFAULT_TENANT_ID)).id;
    const sessionAlive = async (id: string) =>
      (await full.app.get(SessionService).get(id)) !== null;

    /** GET the form (anonymous CSRF cookie) then POST it urlencoded. */
    const submit = async (page: string, fields: Record<string, string | string[]>) => {
      const form = await get(page);
      const anon = setCookies(form)
        .find((c) => c.startsWith(`${ANON_COOKIE}=`))!
        .split(';')[0];
      const token = form.body.match(/name="_csrf" value="([^"]+)"/)![1];
      const body = new URLSearchParams();
      body.append('_csrf', token);
      for (const [k, v] of Object.entries(fields)) {
        for (const one of ([] as string[]).concat(v)) body.append(k, one);
      }
      return full.app.inject({
        method: 'POST',
        url: page,
        headers: { cookie: anon, 'content-type': 'application/x-www-form-urlencoded' },
        payload: body.toString(),
      }) as Promise<InjectResponse>;
    };
    const resetCode = async () => {
      const email = `r86t-reset-${randomUUID()}@example.com`;
      await full.app.get(UserService).create({ email, password: PASSWORD });
      await full.app.get(AuthenticationService).forgotPassword(email);
      await flushMail();
      return {
        email,
        code: tokenFromMailLink(full.outbox.filter((m) => m.to === email).at(-1)!.text),
      };
    };

    describe('F1: token-fragment.js behaviour (served bytes, node:vm)', () => {
      const T43 = 'A'.repeat(20) + '_-' + 'z9'.repeat(10) + 'Q'; // 43 base64url chars

      it('sanity: the served script is the static asset and the 43-char fixture is valid', () => {
        expect(script).toContain('replaceState');
        expect(T43).toMatch(/^[A-Za-z0-9_-]{43}$/);
      });

      it('a valid #token=<43> fills .value exactly, hides the label, drops hash AND query from the URL', () => {
        const r = runFragmentScript(script, `#token=${T43}`);
        expect(r.field.value).toBe(T43);
        expect(r.label.hidden).toBe(true);
        expect(r.replaceState).toHaveBeenCalledTimes(1);
        expect(r.replaceState).toHaveBeenCalledWith(null, '', '/reset');
      });

      it.each([
        ['trailing &x=1', `#token=${T43}&x=1`],
        ['42 chars', `#token=${T43.slice(1)}`],
        ['44 chars', `#token=${T43}A`],
        ['percent-encoded chars', `#token=${'%41'.repeat(43)}`],
        ['trailing newline (JS `$` is end-of-input)', `#token=${T43}\n`],
        ['trailing %0A', `#token=${T43}%0A`],
        ['base64 (not url) alphabet', `#token=${T43.slice(0, 41)}+/`],
        ['HTML payload', '#token="><img src=x onerror=alert(1)>'],
        ['zero-width space inside', `#token=${T43.slice(0, 20)}\u200b${T43.slice(20, 42)}`],
        ['empty value', '#token='],
        ['second token param', `#token=${T43}#token=${T43}`],
      ])('%s => field NOT filled, label visible, fragment still dropped', (_n, hash) => {
        const r = runFragmentScript(script, hash);
        expect(r.field.value).toBe('');
        expect(r.label.hidden).toBe(false);
        expect(r.replaceState).toHaveBeenCalledWith(null, '', '/reset');
      });

      it.each([
        ['no fragment', ''],
        ['unrelated fragment', '#section-2'],
        ['upper-case key (we never mint it)', `#TOKEN=${T43}`],
        ['token not first', `#x=1&token=${T43}`],
      ])('%s => untouched page and history', (_n, hash) => {
        const r = runFragmentScript(script, hash);
        expect(r.field.value).toBe('');
        expect(r.label.hidden).toBe(false);
        expect(r.replaceState).not.toHaveBeenCalled();
      });

      it('missing field/label (other page, markup change) => no throw, fragment still dropped', () => {
        expect(() => runFragmentScript(script, `#token=${T43}`, { field: false })).not.toThrow();
        const r = runFragmentScript(script, `#token=${T43}`, { label: false });
        expect(r.field.value).toBe('');
        expect(r.replaceState).toHaveBeenCalledTimes(1);
      });
    });

    describe('F2: rendered pages carry no inline script and never reflect a token', () => {
      const scriptsOf = (html: string) =>
        [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map((m) => ({
          attrs: m[1],
          body: m[2],
        }));

      it.each(['/reset', '/verify-email', '/logout', '/login', '/forgot', '/register'])(
        'GET %s: every <script> is an empty same-origin /assets/*.js, no on* handlers, CSP script-src has no unsafe-inline',
        async (path) => {
          const res = await get(path);
          expect(res.statusCode).toBe(200);
          for (const s of scriptsOf(res.body)) {
            expect(s.attrs).toMatch(/^\s+src="\/assets\/[a-z-]+\.js"$/);
            expect(s.body).toBe('');
          }
          expect(res.body).not.toMatch(/\son[a-z]+=/i);
          const csp = String(res.headers['content-security-policy']);
          const scriptSrc = /script-src ([^;]+)/.exec(csp)?.[1] ?? '';
          expect(scriptSrc).not.toContain('unsafe-inline');
          expect(res.headers['referrer-policy']).toBe('no-referrer');
        },
      );

      it.each(['/reset', '/verify-email'])(
        'GET %s never reflects a token from the query (also %%23-encoded), nor from Referer',
        async (path) => {
          for (const url of [
            `${path}?token=${MARK}`,
            `${path}?token=${MARK}%23token%3D${MARK}`,
            `${path}?%23token=${MARK}`,
            `${path}?token=${MARK}&token=${MARK}`,
            `${path}?token[]=${MARK}`,
          ]) {
            const res = await get(url, {
              referer: `https://mail.example/inbox?token=${MARK}#token=${MARK}`,
            });
            expect(res.statusCode).toBe(200);
            expect(res.body).not.toContain(MARK);
            expect(allHeaders(res)).not.toContain(MARK);
            expect(res.body).toMatch(/<input[^>]*name="token"[^>]*value=""/);
          }
        },
      );

      it.each([
        ['an unknown token', { token: MARK, password: NEW_PASSWORD }],
        ['a too-short password', { token: MARK, password: 'x' }],
        ['a repeated token field', { token: [MARK, MARK], password: NEW_PASSWORD }],
      ])('POST /reset with %s => 4xx and the submitted token is not echoed', async (_n, fields) => {
        const res = await submit('/reset', fields);
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(res.statusCode).toBeLessThan(500);
        expect(res.body).not.toContain(MARK);
        expect(allHeaders(res)).not.toContain(MARK);
      });

      it('POST /verify-email with an unknown token => 4xx, no echo', async () => {
        const res = await submit('/verify-email', { token: MARK });
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(res.statusCode).toBeLessThan(500);
        expect(res.body).not.toContain(MARK);
      });
    });

    describe('F3: pasted code with unicode whitespace / zero-width / homoglyph characters', () => {
      it('zero-width, word-joiner, homoglyph and inner-space variants are rejected and do NOT consume the token; the clean code then works once', async () => {
        const { email, code } = await resetCode();
        const swapFirst = (c: string) => (c[0] === '\u0430' ? 'a' : '\u0430') + c.slice(1); // Cyrillic а
        for (const variant of [
          `\u200b${code}`,
          `${code}\u200b`,
          `${code.slice(0, 10)}\u200c${code.slice(10)}`,
          `\u2060${code}`,
          `${code.slice(0, 21)} ${code.slice(21)}`,
          swapFirst(code),
          code.toUpperCase() === code ? code.toLowerCase() : code.toUpperCase(),
        ]) {
          const res = await submit('/reset', { token: variant, password: NEW_PASSWORD });
          expect(res.statusCode).toBeGreaterThanOrEqual(400);
          expect(res.statusCode).toBeLessThan(500);
          expect(res.body).not.toContain('Password changed');
        }
        const ok = await submit('/reset', { token: code, password: NEW_PASSWORD });
        expect(ok.statusCode).toBe(201);
        expect(ok.body).toContain('Password changed');
        expect(
          await full.app
            .get(AuthenticationService)
            .login(email, NEW_PASSWORD, { ip: '198.51.100.7' }),
        ).toBeDefined();
      });

      it.each([
        ['NBSP', '\u00a0'],
        ['ideographic space', '\u3000'],
        ['BOM', '\ufeff'],
        ['tab + CRLF', '\t\r\n'],
      ])('%s around the code is trimmed (String#trim) => accepted', async (_n, ws) => {
        const { code } = await resetCode();
        const ok = await submit('/reset', { token: `${ws}${code}${ws}`, password: NEW_PASSWORD });
        expect(ok.statusCode).toBe(201);
      });

      it('POST /verify-email: a zero-width prefixed code is rejected and the token survives', async () => {
        const email = `r86t-verify-${randomUUID()}@example.com`;
        await full.app.get(AuthenticationService).register(email, PASSWORD);
        await flushMail();
        const code = tokenFromMailLink(full.outbox.filter((m) => m.to === email).at(-1)!.text);
        const bad = await submit('/verify-email', { token: `\u200b${code}` });
        expect(bad.statusCode).toBeGreaterThanOrEqual(400);
        expect(
          (await full.app.get(UserService).findByEmail(email))?.emailVerifiedAt ?? null,
        ).toBeNull();
        const ok = await submit('/verify-email', { token: code });
        expect(ok.statusCode).toBe(201);
      });
    });

    describe('L1: POST /logout body shapes (real app, real session)', () => {
      const post = (payload: string, contentType: string, cookie: string) =>
        full.app.inject({
          method: 'POST',
          url: '/logout',
          headers: { 'content-type': contentType, cookie },
          payload,
        }) as Promise<InjectResponse>;

      it('urlencoded _csrf repeated (even both valid) => 400, session untouched', async () => {
        const sid = await newSession();
        const t = csrf.token(sid);
        const res = await post(
          `_csrf=${t}&_csrf=${t}`,
          'application/x-www-form-urlencoded',
          `${SESSION_COOKIE}=${sid}`,
        );
        expect(res.statusCode).toBe(400);
        expect(String(res.headers['set-cookie'] ?? '')).not.toContain(`${SESSION_COOKIE}=;`);
        expect(await sessionAlive(sid)).toBe(true);
      });

      it.each([
        ['number', '{"_csrf":123}'],
        ['null', '{"_csrf":null}'],
        ['object', '{"_csrf":{"toString":"x"}}'],
        ['boolean', '{"_csrf":true}'],
      ])('JSON _csrf %s => 400, session untouched', async (_n, json) => {
        const sid = await newSession();
        const res = await post(json, 'application/json', `${SESSION_COOKIE}=${sid}`);
        expect(res.statusCode).toBe(400);
        expect(await sessionAlive(sid)).toBe(true);
      });

      it('JSON body without _csrf (RP params) => 200 confirmation, session untouched', async () => {
        const sid = await newSession();
        const res = await post(
          JSON.stringify({ client_id: client.clientId, state: 'st' }),
          'application/json',
          `${SESSION_COOKIE}=${sid}`,
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('<form method="post" action="/logout">');
        expect(res.headers['cache-control']).toBe('no-store');
        expect(await sessionAlive(sid)).toBe(true);
      });

      it('JSON array / string bodies and text/plain never 5xx and never end the session', async () => {
        const sid = await newSession();
        const t = csrf.token(sid);
        for (const [payload, type] of [
          [JSON.stringify([{ _csrf: t }]), 'application/json'],
          [JSON.stringify(t), 'application/json'],
          [`_csrf=${t}`, 'text/plain'],
        ] as const) {
          const res = await post(payload, type, `${SESSION_COOKIE}=${sid}`);
          expect(res.statusCode).toBeLessThan(500);
          expect(res.statusCode).not.toBe(302);
        }
        expect(await sessionAlive(sid)).toBe(true);
      });

      it('_csrf = HMAC of ANOTHER live session => 403, neither session ends', async () => {
        const a = await newSession();
        const b = await newSession();
        const res = await post(
          `_csrf=${csrf.token(b)}`,
          'application/x-www-form-urlencoded',
          `${SESSION_COOKIE}=${a}`,
        );
        expect(res.statusCode).toBe(403);
        expect(await sessionAlive(a)).toBe(true);
        expect(await sessionAlive(b)).toBe(true);
      });
    });

    describe('L2: POST /logout with a REAL id_token_hint and near-miss post_logout_redirect_uri', () => {
      const confirm = (fields: Record<string, string>) =>
        full.app.inject({
          method: 'POST',
          url: '/logout',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          payload: new URLSearchParams(fields).toString(),
        }) as Promise<InjectResponse>;

      it('control: the registered URI is reflected by the no-_csrf POST and is the 302 target of the _csrf POST', async () => {
        const sid = await newSession();
        const { id_token } = await issueTokens(full, client, sid);
        const page = await confirm({
          id_token_hint: id_token,
          post_logout_redirect_uri: POST_LOGOUT,
          state: 'st',
        });
        expect(page.statusCode).toBe(200);
        expect(page.body).toContain(`name="post_logout_redirect_uri" value="${POST_LOGOUT}"`);
        expect(page.headers['content-security-policy']).toBe(
          buildCsp({ formAction: ['https://app.example.com'] }),
        );
        const done = await full.app.inject({
          method: 'POST',
          url: '/logout',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            cookie: `${SESSION_COOKIE}=${sid}`,
          },
          payload: new URLSearchParams({
            _csrf: csrf.token(sid),
            id_token_hint: id_token,
            post_logout_redirect_uri: POST_LOGOUT,
            state: 'st',
          }).toString(),
        });
        expect(done.statusCode).toBe(302);
        expect(done.headers['location']).toBe(`${POST_LOGOUT}?state=st`);
        expect(await sessionAlive(sid)).toBe(false);
      });

      it.each([
        ['trailing slash', `${POST_LOGOUT}/`],
        ['extra query', `${POST_LOGOUT}?next=https://evil.example`],
        ['fragment', `${POST_LOGOUT}#x`],
        ['suffix host', 'https://app.example.com.evil.example/after-logout'],
        ['userinfo trick', 'https://app.example.com@evil.example/after-logout'],
        ['http downgrade', 'http://app.example.com/after-logout'],
        ['javascript: scheme', 'javascript:alert(1)//https://app.example.com/after-logout'],
        ['percent-encoded path', 'https://app.example.com/after%2Dlogout'],
      ])(
        '%s: POST without _csrf never reflects it (CSP self only); POST with _csrf redirects locally and ends the session',
        async (_n, uri) => {
          const sid = await newSession();
          const { id_token } = await issueTokens(full, client, sid);
          const page = await confirm({
            id_token_hint: id_token,
            post_logout_redirect_uri: uri,
            state: 'st',
          });
          expect(page.statusCode).toBe(200);
          expect(page.body).not.toContain('name="post_logout_redirect_uri"');
          expect(page.body).not.toContain('evil.example');
          expect(page.headers['content-security-policy']).toBe(buildCsp());
          expect(await sessionAlive(sid)).toBe(true);

          const done = await full.app.inject({
            method: 'POST',
            url: '/logout',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              cookie: `${SESSION_COOKIE}=${sid}`,
            },
            payload: new URLSearchParams({
              _csrf: csrf.token(sid),
              id_token_hint: id_token,
              post_logout_redirect_uri: uri,
              state: 'st',
            }).toString(),
          });
          expect(done.statusCode).toBe(302);
          expect(done.headers['location']).toBe('/login?loggedOut=1');
          expect(await sessionAlive(sid)).toBe(false);
        },
      );
    });

    // Last in this app: rotations change the key the app signs with.
    describe('K1: KEY_PREPUBLISH_SEC=86400 through the real factory; the pending key never signs', () => {
      it('boundary 86400 reaches the Local provider; rotate → pending for 24 h; 200 provider signatures and 5 real /token responses all use the old kid; JWKS has both', async () => {
        const provider = full.app.get<LocalKeyProvider>(KEY_PROVIDER);
        expect(provider).toBeInstanceOf(LocalKeyProvider);
        expect(provider.prepublishSec).toBe(86400);
        const [old] = await provider.listKeys();
        const before = Date.now();
        const r = await provider.rotate('normal', TTL);
        expect(r.oldKid).toBe(old.kid);
        const act = Date.parse(r.activatesAt);
        expect(act - before).toBeGreaterThanOrEqual(86400_000);
        expect(act - Date.now()).toBeLessThanOrEqual(86400_000);

        const jwks = (await get('/jwks.json')).json<{ keys: { kid: string }[] }>().keys;
        expect(jwks.map((k) => k.kid).sort()).toEqual([old.kid, r.newKid].sort());

        const tokens = await Promise.all(
          Array.from({ length: 200 }, (_, i) => provider.signJwt({ typ: 'JWT' }, { i })),
        );
        const kids = new Set(tokens.map((t) => decodeProtectedHeader(t).kid));
        expect([...kids]).toEqual([old.kid]);

        for (let i = 0; i < 5; i++) {
          const t = await issueTokens(full, client, await newSession());
          expect(decodeProtectedHeader(t.access_token).kid).toBe(old.kid);
          expect(decodeProtectedHeader(t.id_token).kid).toBe(old.kid);
        }
        expect((await provider.listKeys()).map((k) => [k.kid, k.status])).toEqual([
          [old.kid, 'active'],
          [r.newKid, 'pending'],
        ]);
      });

      it('rotate → 409 → emergency → normal → 409: emergency drops the pending key, the next normal rotation is pending again', async () => {
        const provider = full.app.get<LocalKeyProvider>(KEY_PROVIDER);
        await expect(provider.rotate('normal', TTL)).rejects.toBeInstanceOf(RotationPendingError);
        const e = await provider.rotate('emergency', TTL);
        expect(e.activatesAt).toBe((await provider.listKeys())[0].createdAt);
        expect((await provider.listKeys()).map((k) => [k.kid, k.status])).toEqual([
          [e.newKid, 'active'],
        ]);
        const jwks = (await get('/jwks.json')).json<{ keys: { kid: string }[] }>().keys;
        expect(jwks.map((k) => k.kid)).toEqual([e.newKid]);
        expect(decodeProtectedHeader(await provider.signJwt({ typ: 'JWT' }, {})).kid).toBe(
          e.newKid,
        );

        const n = await provider.rotate('normal', TTL);
        expect(n.oldKid).toBe(e.newKid);
        expect((await provider.listKeys()).map((k) => [k.kid, k.status])).toEqual([
          [e.newKid, 'active'],
          [n.newKid, 'pending'],
        ]);
        expect(decodeProtectedHeader(await provider.signJwt({ typ: 'JWT' }, {})).kid).toBe(
          e.newKid,
        );
        await expect(provider.rotate('normal', TTL)).rejects.toBeInstanceOf(RotationPendingError);
      });
    });
  });

  // ------------------------------------------------------------------------------------------
  // Secure-cookie app: __Host- names; KEY_PREPUBLISH_SEC='' => default 3600.
  // ------------------------------------------------------------------------------------------
  describe('secure app (SESSION_COOKIE_SECURE=true, KEY_PREPUBLISH_SEC="")', () => {
    let full: FullApp;
    let userId = '';
    let csrf: CsrfService;
    const HOST_SESSION = `__Host-${SESSION_COOKIE}`;
    const HOST_ANON = `__Host-${ANON_COOKIE}`;

    const boot = async (): Promise<void> => {
      full = await bootFullApp({
        name: 'run86-tester-secure',
        env: { SESSION_COOKIE_SECURE: 'true', KEY_PREPUBLISH_SEC: '' },
      });
      ({ userId } = await seedRp(full));
      csrf = full.app.get(CsrfService);
    };
    let setup: Promise<void> | undefined;
    beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS);
    afterAll(async () => {
      await settled(setup);
      await full?.close();
    }, INT_SETUP_TIMEOUT_MS);

    const newSession = async () =>
      (await full.app.get(SessionService).create(userId, DEFAULT_TENANT_ID)).id;
    const alive = async (id: string) => (await full.app.get(SessionService).get(id)) !== null;
    const postLogout = (cookie: string, token: string) =>
      full.app.inject({
        method: 'POST',
        url: '/logout',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        payload: `_csrf=${encodeURIComponent(token)}`,
      }) as Promise<InjectResponse>;

    it('KEY_PREPUBLISH_SEC="" => the factory-built provider uses the 3600 default', () => {
      expect(full.app.get<LocalKeyProvider>(KEY_PROVIDER).prepublishSec).toBe(3600);
    });

    it('cross-site confirmation mints __Host-idp_csrf (Secure, Path=/, no Domain, HttpOnly)', async () => {
      const res = (await full.app.inject({
        method: 'POST',
        url: '/logout',
        payload: { client_id: 'rp' },
      })) as InjectResponse;
      expect(res.statusCode).toBe(200);
      const c = setCookies(res).find((s) => s.startsWith(`${HOST_ANON}=`))!;
      expect(c).toBeDefined();
      expect(c).toMatch(/;\s*Secure/i);
      expect(c).toMatch(/;\s*Path=\//i);
      expect(c).toMatch(/;\s*HttpOnly/i);
      expect(c).not.toMatch(/Domain=/i);
      expect(setCookies(res).some((s) => s.startsWith(`${ANON_COOKIE}=`))).toBe(false);
    });

    it('a tossed NON-__Host anonymous cookie (idp_csrf=X) + HMAC(X) => 403, session lives', async () => {
      const sid = await newSession();
      const x = randomBytes(32).toString('base64url');
      const res = await postLogout(`${HOST_SESSION}=${sid}; ${ANON_COOKIE}=${x}`, csrf.token(x));
      expect(res.statusCode).toBe(403);
      expect(await alive(sid)).toBe(true);
    });

    it('a tossed NON-__Host session cookie (idp_session=S) + HMAC(S) => 403, session lives', async () => {
      const sid = await newSession();
      const res = await postLogout(`${SESSION_COOKIE}=${sid}`, csrf.token(sid));
      expect(res.statusCode).toBe(403);
      expect(await alive(sid)).toBe(true);
    });

    it('control: __Host-idp_csrf=X + HMAC(X) with the __Host- session => 302, session ended', async () => {
      const sid = await newSession();
      const x = randomBytes(32).toString('base64url');
      const res = await postLogout(`${HOST_SESSION}=${sid}; ${HOST_ANON}=${x}`, csrf.token(x));
      expect(res.statusCode).toBe(302);
      expect(await alive(sid)).toBe(false);
    });
  });

  // ------------------------------------------------------------------------------------------
  // KEY_PREPUBLISH_SEC values that must fail the REAL boot, and the accepted grammar.
  // ------------------------------------------------------------------------------------------
  describe('K2: KEY_PREPUBLISH_SEC boundary values', () => {
    it.each(['86401', ' 5', '1e3', '-1'])(
      '%j => the real app does not boot (error names the variable)',
      async (v) => {
        await expect(
          bootFullApp({ name: 'run86-tester-badenv', env: { KEY_PREPUBLISH_SEC: v } }),
        ).rejects.toThrow(/KEY_PREPUBLISH_SEC/);
      },
      INT_SETUP_TIMEOUT_MS,
    );

    // Same minimal valid env as `validation.schema.spec.ts` BASE (no I/O: validateEnv only).
    const base = (): Record<string, string> => ({
      NODE_ENV: 'development',
      ISSUER: 'http://localhost:4000',
      MONGO_URI: 'mongodb://x',
      REDIS_URL: 'redis://x',
      ACCESS_TOKEN_TTL: '900',
      REFRESH_TOKEN_TTL: '2592000',
      SESSION_IDLE_TTL: '28800',
      SESSION_ABSOLUTE_TTL: '2592000',
      KEY_LOCAL_DIR: './keys',
      SMTP_URL: 'smtp://x',
      ADMIN_SEED_EMAIL: 'a@example.com',
      CSRF_SECRET: 's',
      RATE_LIMIT_WINDOW: '60',
      RATE_LIMIT_MAX: '100',
    });
    it.each([
      ['0', 0],
      ['86400', 86400],
      ['', 3600],
      ['00', 0],
      ['0086400', 86400],
    ])('%j => %d', (v, want) => {
      expect(validateEnv({ ...base(), KEY_PREPUBLISH_SEC: v }).KEY_PREPUBLISH_SEC).toBe(want);
    });
    it.each(['86401', '1e3', ' 5', '5 ', '+5', '-0', '0x10', '5.0', '\u0665', '\uff15', '86400\n'])(
      '%j => validation error',
      (v) => {
        expect(() => validateEnv({ ...base(), KEY_PREPUBLISH_SEC: v })).toThrow(
          /KEY_PREPUBLISH_SEC/,
        );
      },
    );
  });

  // ------------------------------------------------------------------------------------------
  // K3/K4: Local provider with a controlled clock (no app): concurrency mix and legacy state.
  // ------------------------------------------------------------------------------------------
  describe('K3/K4: LocalKeyProvider concurrency mix and legacy keys.json', () => {
    let dir: string;
    let clock = Date.now();
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'vg-run86-tester-keys-'));
      clock = Date.now();
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    const make = (prepublishSec = 3600) =>
      new LocalKeyProvider(dir, { prepublishSec, now: () => clock });
    const pems = async () =>
      (await readdir(dir))
        .filter((f) => f.endsWith('.pem'))
        .map((f) => f.slice(0, -4))
        .sort();
    const signedKid = async (p: LocalKeyProvider) =>
      decodeProtectedHeader(await p.signJwt({ typ: 'JWT' }, {})).kid;

    it('boundary: 100 concurrent signatures 1 ms before activatesAt use the old kid, at activatesAt the new one', async () => {
      const p = make();
      await p.init();
      const [old] = await p.listKeys();
      const r = await p.rotate('normal', TTL);
      const act = Date.parse(r.activatesAt);
      clock = act - 1;
      const before = await Promise.all(Array.from({ length: 100 }, () => signedKid(p)));
      expect(new Set(before)).toEqual(new Set([old.kid]));
      clock = act;
      const after = await Promise.all(Array.from({ length: 100 }, () => signedKid(p)));
      expect(new Set(after)).toEqual(new Set([r.newKid]));
    });

    it('[normal, normal, emergency, normal] fired together => [ok, 409, ok, ok] in call order; final = emergency key active + one pending; PEMs = exactly those two', async () => {
      const p = make();
      await p.init();
      const settledAll = await Promise.allSettled([
        p.rotate('normal', TTL),
        p.rotate('normal', TTL),
        p.rotate('emergency', TTL),
        p.rotate('normal', TTL),
      ]);
      expect(settledAll.map((s) => s.status)).toEqual([
        'fulfilled',
        'rejected',
        'fulfilled',
        'fulfilled',
      ]);
      expect((settledAll[1] as PromiseRejectedResult).reason).toBeInstanceOf(RotationPendingError);
      const e = (settledAll[2] as PromiseFulfilledResult<{ newKid: string }>).value;
      const n = (settledAll[3] as PromiseFulfilledResult<{ newKid: string; oldKid: string }>).value;
      expect(n.oldKid).toBe(e.newKid);
      expect((await p.listKeys()).map((k) => [k.kid, k.status])).toEqual([
        [e.newKid, 'active'],
        [n.newKid, 'pending'],
      ]);
      expect(await pems()).toEqual([e.newKid, n.newKid].sort());
      expect(await signedKid(p)).toBe(e.newKid);
    });

    it('[emergency, normal, emergency] together => final state is one active key and one PEM', async () => {
      const p = make();
      await p.init();
      const res = await Promise.all([
        p.rotate('emergency', TTL),
        p.rotate('normal', TTL),
        p.rotate('emergency', TTL),
      ]);
      const last = res[2].newKid;
      expect((await p.listKeys()).map((k) => [k.kid, k.status])).toEqual([[last, 'active']]);
      expect(await pems()).toEqual([last]);
      expect(await signedKid(p)).toBe(last);
    });

    const legacyKey = async (kid: string) => {
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      await writeFile(
        join(dir, `${kid}.pem`),
        privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
      );
      const { n, e } = createPublicKey(privateKey).export({ format: 'jwk' });
      return { kty: 'RSA', kid, alg: 'RS256', use: 'sig', n, e };
    };

    it('legacy keys.json whose status fields contradict the order ([A "active" + retireAt, B "pending"]) => B active, A retiring; reads never rewrite the file; the next normal rotation writes no status, keeps B\'s PEM, drops A\'s', async () => {
      const A = `legacy-a-${randomUUID()}`;
      const B = `legacy-b-${randomUUID()}`;
      const retireAt = new Date(clock + 3600_000).toISOString();
      const state = [
        {
          kid: A,
          publicJwk: await legacyKey(A),
          createdAt: new Date(clock - 7200_000).toISOString(),
          status: 'active',
          retireAt,
        },
        {
          kid: B,
          publicJwk: await legacyKey(B),
          createdAt: new Date(clock - 3600_000).toISOString(),
          status: 'pending',
        },
      ];
      const file = join(dir, 'keys.json');
      const bytes = JSON.stringify(state, null, 2);
      await writeFile(file, bytes);

      const p = make();
      await p.init();
      expect((await p.listKeys()).map((k) => [k.kid, k.status, k.retireAt])).toEqual([
        [A, 'retiring', retireAt],
        [B, 'active', null],
      ]);
      expect(await signedKid(p)).toBe(B);
      await p.getPublicKeys();
      expect(await readFile(file, 'utf8')).toBe(bytes);

      const r = await p.rotate('normal', TTL);
      const written = await readFile(file, 'utf8');
      expect(written).not.toContain('"status"');
      expect(await pems()).toEqual([B, r.newKid].sort());
      expect((await p.listKeys()).map((k) => [k.kid, k.status])).toEqual([
        [A, 'retiring'],
        [B, 'active'],
        [r.newKid, 'pending'],
      ]);
      expect(await signedKid(p)).toBe(B);
    });

    it('legacy single entry marked "retiring" with a past retireAt => still the active key (status ignored); init creates nothing', async () => {
      const A = `legacy-only-${randomUUID()}`;
      const state = [
        {
          kid: A,
          publicJwk: await legacyKey(A),
          createdAt: new Date(clock - 86400_000).toISOString(),
          status: 'retiring',
          retireAt: new Date(clock - 3600_000).toISOString(),
        },
      ];
      const file = join(dir, 'keys.json');
      const bytes = JSON.stringify(state);
      await writeFile(file, bytes);
      const p = make();
      await p.init();
      expect(await readFile(file, 'utf8')).toBe(bytes);
      expect((await p.listKeys()).map((k) => [k.kid, k.status])).toEqual([[A, 'active']]);
      expect(await signedKid(p)).toBe(A);
      expect(await pems()).toEqual([A]);
    });
  });
});
