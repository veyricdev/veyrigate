import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { GITHUB, GOOGLE, type FederationProviders } from '../../src/modules/federation/providers';

/**
 * Marker scanned by `assert-dist-clean.mjs` (F20): if it ever shows up under `be/dist/`, test-only
 * provider wiring leaked into the production build (INV-23).
 */
export const E2E_MOCK_MARKER = '__E2E_MOCK_PROVIDER__';

const CLIENT_ID = 'e2e-mock-google-client';

interface Grant {
  challenge: string;
  redirectUri: string;
  nonce: string;
  sub: string;
  email: string;
  emailVerified: boolean;
  authTime: number;
}

const b64url = (buf: Buffer) => buf.toString('base64url');
const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString('utf8');
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => resolve(new URLSearchParams(body)));
    req.on('error', reject);
  });
}

/**
 * Minimal Google stand-in for E2E (F19), on 127.0.0.1 with a random port, in the E2E process only.
 * - `GET /authorize`: an HTML form (sub, email, email_verified) for Playwright to fill; the OAuth
 *   params travel as hidden fields. `POST /authorize` => 302 `redirect_uri?code&state`.
 * - `POST /token`: client id/secret, `redirect_uri`, PKCE S256 and single-use code checked; returns
 *   an RS256 ID token (`iss/aud/sub/nonce/exp/iat/email/email_verified/auth_time`).
 * - Signing keys are generated at boot; the IdP verifies them through a local JWK set.
 * It never logs (no code/state/token in output).
 */
export async function startMockGoogle(
  expectedRedirectUri: string,
): Promise<{ registry: FederationProviders }> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'e2e-mock-k1', alg: 'RS256' } as JWK;
  const clientSecret = b64url(randomBytes(24));
  const grants = new Map<string, Grant>();

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const html = (status: number, body: string) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><html><head><title>Mock Google</title></head><body>${body}</body></html>`,
        );
      };
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      if (req.method === 'GET' && url.pathname === '/authorize') {
        const q = url.searchParams;
        if (q.get('client_id') !== CLIENT_ID || q.get('redirect_uri') !== expectedRedirectUri) {
          return html(400, '<p>invalid client</p>');
        }
        const hidden = ['redirect_uri', 'state', 'nonce', 'code_challenge', 'code_challenge_method']
          .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(q.get(k) ?? '')}">`)
          .join('');
        return html(
          200,
          `<h1>Mock Google</h1><form method="post" action="/authorize">${hidden}` +
            '<label>Subject<input name="sub" required></label>' +
            '<label>Email<input name="email" required></label>' +
            '<label><input type="checkbox" name="email_verified" value="true" checked>Email verified</label>' +
            '<button type="submit">Continue</button></form>',
        );
      }

      if (req.method === 'POST' && url.pathname === '/authorize') {
        const f = await readBody(req);
        const redirectUri = f.get('redirect_uri') ?? '';
        if (redirectUri !== expectedRedirectUri || f.get('code_challenge_method') !== 'S256') {
          return html(400, '<p>invalid request</p>');
        }
        const code = b64url(randomBytes(24));
        grants.set(code, {
          challenge: f.get('code_challenge') ?? '',
          redirectUri,
          nonce: f.get('nonce') ?? '',
          sub: f.get('sub') ?? '',
          email: f.get('email') ?? '',
          emailVerified: f.get('email_verified') === 'true',
          authTime: Math.floor(Date.now() / 1000),
        });
        const back = new URL(redirectUri);
        back.searchParams.set('code', code);
        back.searchParams.set('state', f.get('state') ?? '');
        res.writeHead(302, { location: back.href });
        return res.end();
      }

      if (req.method === 'POST' && url.pathname === '/token') {
        const f = await readBody(req);
        const code = f.get('code') ?? '';
        const grant = grants.get(code);
        grants.delete(code); // single-use, whatever happens next
        const verifier = f.get('code_verifier') ?? '';
        if (
          !grant ||
          f.get('grant_type') !== 'authorization_code' ||
          f.get('client_id') !== CLIENT_ID ||
          f.get('client_secret') !== clientSecret ||
          f.get('redirect_uri') !== grant.redirectUri ||
          b64url(createHash('sha256').update(verifier).digest()) !== grant.challenge
        ) {
          return json(400, { error: 'invalid_grant' });
        }
        const now = Math.floor(Date.now() / 1000);
        const idToken = await new SignJWT({
          nonce: grant.nonce,
          email: grant.email,
          email_verified: grant.emailVerified,
          auth_time: grant.authTime,
        })
          .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
          .setIssuer(GOOGLE.issuers[0])
          .setAudience(CLIENT_ID)
          .setSubject(grant.sub)
          .setIssuedAt(now)
          .setExpirationTime(now + 300)
          .sign(privateKey);
        return json(200, { access_token: b64url(randomBytes(24)), id_token: idToken });
      }

      json(404, { error: 'not_found' });
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const registry: FederationProviders = {
    google: {
      name: 'google',
      enabled: true,
      clientId: CLIENT_ID,
      clientSecret,
      authorizeUrl: `${base}/authorize`,
      tokenUrl: `${base}/token`,
      scopes: GOOGLE.scopes,
      issuers: GOOGLE.issuers,
      timeoutMs: 5000,
      jwks: createLocalJWKSet({ keys: [jwk] }),
    },
    // GitHub is not exercised end to end (int tests cover it): disabled, no endpoint ever called.
    github: {
      name: 'github',
      enabled: false,
      clientId: '',
      clientSecret: '',
      authorizeUrl: GITHUB.authorizeUrl,
      tokenUrl: GITHUB.tokenUrl,
      userUrl: GITHUB.userUrl,
      emailsUrl: GITHUB.emailsUrl,
      scopes: GITHUB.scopes,
      timeoutMs: 5000,
    },
  };
  // Not kept alive by itself: the process ends with the app (shutdown hooks).
  server.unref();
  return { registry };
}
