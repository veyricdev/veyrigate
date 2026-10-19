import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildConfig } from '../../config/configuration';
import { validateEnv } from '../../config/validation.schema';
import { buildAuthorizeUrl, exchangeCode, verifyGoogleIdToken } from './federation.client';
import { FederationError } from './federation.errors';
import {
  buildFederationProviders,
  enabledProvider,
  enabledProviderNames,
  GITHUB,
  GOOGLE,
  type GithubProvider,
  type GoogleProvider,
} from './providers';
import { providerFetchJson } from './provider-http';

const NONCE = 'n-0123456789';
const CLIENT_ID = 'google-client-id';

async function keySet() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' } as JWK;
  return { privateKey, jwks: createLocalJWKSet({ keys: [jwk] }) };
}

function google(jwks: GoogleProvider['jwks']): GoogleProvider {
  return {
    name: 'google',
    enabled: true,
    clientId: CLIENT_ID,
    clientSecret: 'google-secret',
    authorizeUrl: GOOGLE.authorizeUrl,
    tokenUrl: 'http://127.0.0.1:1/token',
    scopes: GOOGLE.scopes,
    issuers: GOOGLE.issuers,
    timeoutMs: 1000,
    jwks,
  };
}

const github: GithubProvider = {
  name: 'github',
  enabled: true,
  clientId: 'gh-id',
  clientSecret: 'gh-secret',
  authorizeUrl: GITHUB.authorizeUrl,
  tokenUrl: 'http://127.0.0.1:1/gh/token',
  userUrl: 'http://127.0.0.1:1/gh/user',
  emailsUrl: 'http://127.0.0.1:1/gh/emails',
  scopes: GITHUB.scopes,
  timeoutMs: 1000,
};

async function idToken(
  key: Parameters<SignJWT['sign']>[0],
  claims: Record<string, unknown> = {},
  opts: { iss?: string; aud?: string; exp?: number; alg?: string } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ nonce: NONCE, email: 'u@example.com', email_verified: true, ...claims })
    .setProtectedHeader({ alg: opts.alg ?? 'RS256', kid: 'k1' })
    .setIssuer(opts.iss ?? 'https://accounts.google.com')
    .setAudience(opts.aud ?? CLIENT_ID)
    .setSubject('google-sub-1')
    .setIssuedAt(now)
    .setExpirationTime(opts.exp ?? now + 300)
    .sign(key);
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err instanceof FederationError ? err.code : `other:${String(err)}`;
  }
  return 'resolved';
};

describe('Google ID token verification (B5.1, F3)', () => {
  it('valid token => providerId=sub, verified email', async () => {
    const { privateKey, jwks } = await keySet();
    const id = await verifyGoogleIdToken(google(jwks), await idToken(privateKey), { nonce: NONCE });
    expect(id).toEqual({ providerId: 'google-sub-1', email: 'u@example.com' });
  });

  it('accepts the bare `accounts.google.com` issuer too', async () => {
    const { privateKey, jwks } = await keySet();
    const token = await idToken(privateKey, {}, { iss: 'accounts.google.com' });
    await expect(verifyGoogleIdToken(google(jwks), token, { nonce: NONCE })).resolves.toBeTruthy();
  });

  it('email_verified=false => no email (cannot provision)', async () => {
    const { privateKey, jwks } = await keySet();
    const token = await idToken(privateKey, { email_verified: false });
    expect(await verifyGoogleIdToken(google(jwks), token, { nonce: NONCE })).toEqual({
      providerId: 'google-sub-1',
    });
  });

  it.each([
    ['wrong iss', {}, { iss: 'https://evil.example' }],
    ['wrong aud', {}, { aud: 'other-client' }],
    ['expired (beyond 60s skew)', {}, { exp: Math.floor(Date.now() / 1000) - 120 }],
    ['wrong nonce', { nonce: 'other-nonce' }, {}],
    ['missing nonce', { nonce: undefined }, {}],
  ])('%s => invalid_identity', async (_name, claims, opts) => {
    const { privateKey, jwks } = await keySet();
    const token = await idToken(privateKey, claims, opts);
    expect(await code(verifyGoogleIdToken(google(jwks), token, { nonce: NONCE }))).toBe(
      'invalid_identity',
    );
  });

  it('signature by another key => invalid_identity', async () => {
    const { jwks } = await keySet();
    const other = await keySet();
    const token = await idToken(other.privateKey);
    expect(await code(verifyGoogleIdToken(google(jwks), token, { nonce: NONCE }))).toBe(
      'invalid_identity',
    );
  });

  it('HS256 (alg confusion) => invalid_identity', async () => {
    const { jwks } = await keySet();
    const token = await idToken(new TextEncoder().encode('x'.repeat(32)), {}, { alg: 'HS256' });
    expect(await code(verifyGoogleIdToken(google(jwks), token, { nonce: NONCE }))).toBe(
      'invalid_identity',
    );
  });

  it('reauth: stale or missing auth_time => reauth_required; fresh => ok (F8)', async () => {
    const { privateKey, jwks } = await keySet();
    const since = Date.now();
    const stale = await idToken(privateKey, { auth_time: Math.floor(since / 1000) - 3600 });
    const none = await idToken(privateKey);
    const fresh = await idToken(privateKey, { auth_time: Math.floor(since / 1000) });
    const p = google(jwks);
    expect(await code(verifyGoogleIdToken(p, stale, { nonce: NONCE, reauthSince: since }))).toBe(
      'reauth_required',
    );
    expect(await code(verifyGoogleIdToken(p, none, { nonce: NONCE, reauthSince: since }))).toBe(
      'reauth_required',
    );
    await expect(
      verifyGoogleIdToken(p, fresh, { nonce: NONCE, reauthSince: since }),
    ).resolves.toMatchObject({ authTime: Math.floor(since / 1000) });
    expect(await verifyGoogleIdToken(p, none, { nonce: NONCE })).not.toHaveProperty('authTime');
  });
});

describe('authorize URL (B5.1)', () => {
  it('Google: PKCE S256 + nonce, max_age only with reauthAfter (seconds since it); base is the hard-coded endpoint', async () => {
    const { jwks } = await keySet();
    const leg = {
      state: 's',
      nonce: 'n',
      codeChallenge: 'c',
      redirectUri: 'http://localhost:4000/auth/google/callback',
    };
    const plain = new URL(buildAuthorizeUrl(google(jwks), leg));
    expect(plain.origin + plain.pathname).toBe(GOOGLE.authorizeUrl);
    expect(Object.fromEntries(plain.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: leg.redirectUri,
      response_type: 'code',
      scope: 'openid email',
      state: 's',
      code_challenge: 'c',
      code_challenge_method: 'S256',
      nonce: 'n',
    });
    const reauth = new URL(buildAuthorizeUrl(google(jwks), { ...leg, reauthAfter: Date.now() }));
    expect(reauth.searchParams.get('max_age')).toBe('0');
    // DEBT-189 (F2): max_age = whole seconds elapsed since the demand, never negative.
    const sixty = new URL(
      buildAuthorizeUrl(google(jwks), { ...leg, reauthAfter: Date.now() - 60_000 }),
    );
    expect(['60', '61']).toContain(sixty.searchParams.get('max_age'));
    const future = new URL(
      buildAuthorizeUrl(google(jwks), { ...leg, reauthAfter: Date.now() + 60_000 }),
    );
    expect(future.searchParams.get('max_age')).toBe('0');
  });

  it('GitHub: no nonce/max_age, scopes read:user user:email', () => {
    const url = new URL(
      buildAuthorizeUrl(github, {
        state: 's',
        nonce: 'n',
        codeChallenge: 'c',
        redirectUri: 'r',
        reauthAfter: Date.now(),
      }),
    );
    expect(url.origin + url.pathname).toBe(GITHUB.authorizeUrl);
    expect(url.searchParams.get('scope')).toBe('read:user user:email');
    expect(url.searchParams.has('nonce')).toBe(false);
    expect(url.searchParams.has('max_age')).toBe(false);
  });
});

describe('GitHub exchange + provider HTTP (B5.1, F2)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  function mockGithub(emails: unknown, token: unknown = { access_token: 'gho_x' }) {
    const calls: { url: string; init: RequestInit }[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url === github.tokenUrl) return json(token);
      if (url === github.userUrl) return json({ id: 4242, login: 'renamable' });
      if (url === github.emailsUrl) return json(emails);
      throw new Error('unexpected url');
    });
    return calls;
  }
  const input = { code: 'c', codeVerifier: 'v', nonce: 'n', redirectUri: 'r' };

  it('primary+verified email is used; providerId is the numeric id (never login)', async () => {
    const calls = mockGithub([
      { email: 'other@example.com', primary: false, verified: true },
      { email: 'me@example.com', primary: true, verified: true },
    ]);
    expect(await exchangeCode(github, input)).toEqual({
      providerId: '4242',
      email: 'me@example.com',
    });
    // Every call: redirect error + timeout signal + JSON accept; API calls carry User-Agent.
    for (const c of calls) {
      expect(c.init.redirect).toBe('error');
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
    }
    expect((calls[1].init.headers as Record<string, string>)['User-Agent']).toBeTruthy();
  });

  it.each([
    ['primary but unverified', [{ email: 'me@example.com', primary: true, verified: false }]],
    ['verified but not primary', [{ email: 'me@example.com', primary: false, verified: true }]],
    ['no emails', []],
  ])('%s => no email', async (_n, emails) => {
    mockGithub(emails);
    expect(await exchangeCode(github, input)).toEqual({ providerId: '4242' });
  });

  it('token endpoint 200 with `error` body => provider_unavailable', async () => {
    mockGithub([], { error: 'bad_verification_code', error_description: 'secret-ish' });
    expect(await code(exchangeCode(github, input))).toBe('provider_unavailable');
  });

  it('non-2xx / invalid JSON / network error => provider_unavailable (no body leaked)', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ leak: 'x' }, 500));
    expect(await code(providerFetchJson('http://127.0.0.1:1/x', {}, 1000))).toBe(
      'provider_unavailable',
    );
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('not json'));
    expect(await code(providerFetchJson('http://127.0.0.1:1/x', {}, 1000))).toBe(
      'provider_unavailable',
    );
    jest.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('redirect not allowed'));
    expect(await code(providerFetchJson('http://127.0.0.1:1/x', {}, 1000))).toBe(
      'provider_unavailable',
    );
  });
});

describe('static registry (B5.1, F1/F4, INV-23)', () => {
  const env = (over: Record<string, string>) =>
    validateEnv({
      NODE_ENV: 'test',
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
      ...over,
    });

  it('no credentials => both providers disabled', () => {
    const providers = buildFederationProviders(buildConfig(env({})).federation);
    expect(enabledProviderNames(providers)).toEqual([]);
    expect(enabledProvider(providers, 'google')).toBeNull();
    expect(enabledProvider(providers, 'github')).toBeNull();
  });

  it('only a complete pair enables a provider; endpoints stay the hard-coded https constants', () => {
    const providers = buildFederationProviders(
      buildConfig(env({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'sec' })).federation,
    );
    expect(enabledProviderNames(providers)).toEqual(['github']);
    expect(enabledProvider(providers, 'github')).toMatchObject({
      tokenUrl: GITHUB.tokenUrl,
      userUrl: GITHUB.userUrl,
      emailsUrl: GITHUB.emailsUrl,
    });
    expect(providers.google.tokenUrl).toBe(GOOGLE.tokenUrl);
    for (const url of [...Object.values(GOOGLE), ...Object.values(GITHUB)].flat()) {
      if (url.includes('://')) expect(url.startsWith('https://')).toBe(true);
    }
  });

  it('unknown provider names are never resolved (e.g. prototype keys)', () => {
    const providers = buildFederationProviders({ githubClientId: 'a', githubClientSecret: 'b' });
    for (const name of ['mock', '__proto__', 'constructor', 'GITHUB', '']) {
      expect(enabledProvider(providers, name)).toBeNull();
    }
  });

  it('federation source never reads env/request input into a URL; fetch only in the helper', () => {
    const dir = join(process.cwd(), 'src/modules/federation');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect([f, /process\.env|NODE_ENV/.test(src)]).toEqual([f, false]);
      // No URL/redirect_uri from request input (query/body, Host, X-Forwarded-*).
      const fromRequest =
        /\breq\.(query|body)\b|headers\.host|headers\[['"](host|x-forwarded-[a-z]+)['"]\]/i;
      expect([f, fromRequest.test(src)]).toEqual([f, false]);
      if (f !== 'provider-http.ts') expect([f, /\bfetch\(/.test(src)]).toEqual([f, false]);
      if (f !== 'providers.ts') expect([f, /['"`]https?:\/\//.test(src)]).toEqual([f, false]);
    }
  });
});
