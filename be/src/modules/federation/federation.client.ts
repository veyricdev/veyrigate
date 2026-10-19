import { errors, jwtVerify } from 'jose';
import { constantTimeEqual } from '../../common/crypto/crypto.util';
import { FederationError } from './federation.errors';
import type { FederationProvider, GithubProvider, GoogleProvider } from './providers';
import { providerFetchJson } from './provider-http';

/** The identity a provider vouched for. `providerId` is the stable id (Google `sub`, GitHub user id). */
export interface ProviderIdentity {
  providerId: string;
  /** Present only when the provider asserts it verified (Google `email_verified`, GitHub primary+verified). */
  email?: string;
  /** Google `auth_time` (s epoch) when present; GitHub never has one (DEBT-192). */
  authTime?: number;
}

export interface AuthorizeLeg {
  state: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
  /** ms epoch the provider login must be at/after (Google only: sent as `max_age`, DEBT-189 F2). */
  reauthAfter?: number;
}

export interface ExchangeInput {
  code: string;
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
  /** ms epoch: when set, Google's `auth_time` must be at/after it (minus 60s skew, F8). */
  reauthSince?: number;
}

const CLOCK_SKEW_SEC = 60;

/** Build the provider authorize URL (base is the hard-coded registry constant). */
export function buildAuthorizeUrl(provider: FederationProvider, leg: AuthorizeLeg): string {
  const url = new URL(provider.authorizeUrl);
  const params: Record<string, string> = {
    client_id: provider.clientId,
    redirect_uri: leg.redirectUri,
    response_type: 'code',
    scope: provider.scopes,
    state: leg.state,
    code_challenge: leg.codeChallenge,
    code_challenge_method: 'S256',
  };
  if (provider.name === 'google') {
    params.nonce = leg.nonce;
    if (leg.reauthAfter !== undefined) {
      params.max_age = String(Math.max(0, Math.floor((Date.now() - leg.reauthAfter) / 1000)));
    }
  }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.href;
}

/** Spend the provider `code` and return the verified identity. Never retried (single-use code). */
export function exchangeCode(
  provider: FederationProvider,
  input: ExchangeInput,
): Promise<ProviderIdentity> {
  return provider.name === 'google'
    ? exchangeGoogle(provider, input)
    : exchangeGithub(provider, input);
}

function tokenRequestBody(provider: FederationProvider, input: ExchangeInput): string {
  return new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
    code_verifier: input.codeVerifier,
  }).toString();
}

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

async function exchangeGoogle(
  provider: GoogleProvider,
  input: ExchangeInput,
): Promise<ProviderIdentity> {
  const body = (await providerFetchJson(
    provider.tokenUrl,
    { method: 'POST', headers: FORM, body: tokenRequestBody(provider, input) },
    provider.timeoutMs,
  )) as { id_token?: unknown } | null;
  if (typeof body?.id_token !== 'string') throw new FederationError('provider_unavailable');
  return verifyGoogleIdToken(provider, body.id_token, input);
}

/**
 * Verify a Google ID token (F3): RS256 against Google's JWKS, `iss` in the allowlist, `aud` ===
 * our client id, `exp` (60s tolerance), `nonce` === the leg's nonce; with `reauthSince`, `auth_time`
 * must prove a fresh login. No userinfo call. Any failure => `invalid_identity` / `reauth_required`.
 */
export async function verifyGoogleIdToken(
  provider: GoogleProvider,
  idToken: string,
  expected: { nonce: string; reauthSince?: number },
): Promise<ProviderIdentity> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(idToken, provider.jwks, {
      issuer: [...provider.issuers],
      audience: provider.clientId,
      algorithms: ['RS256'],
      clockTolerance: CLOCK_SKEW_SEC,
      requiredClaims: ['exp', 'iat', 'sub', 'nonce'],
    }));
  } catch (err) {
    // DEBT-191 (F16): a JWKS fetch that never got an answer (network error, timeout) is the
    // provider being unavailable (502); every JOSE verification failure is a bad identity.
    if (!(err instanceof errors.JOSEError) || err.code === 'ERR_JWKS_TIMEOUT') {
      throw new FederationError('provider_unavailable');
    }
    throw new FederationError('invalid_identity');
  }
  if (
    typeof payload.nonce !== 'string' ||
    !constantTimeEqual(payload.nonce, expected.nonce) ||
    typeof payload.sub !== 'string' ||
    payload.sub.length === 0
  ) {
    throw new FederationError('invalid_identity');
  }
  if (expected.reauthSince !== undefined) {
    const authTime = payload.auth_time;
    if (
      typeof authTime !== 'number' ||
      authTime * 1000 < expected.reauthSince - CLOCK_SKEW_SEC * 1000
    ) {
      throw new FederationError('reauth_required');
    }
  }
  const verified = payload.email_verified === true && typeof payload.email === 'string';
  return {
    providerId: payload.sub,
    ...(verified ? { email: payload.email as string } : {}),
    ...(typeof payload.auth_time === 'number' ? { authTime: payload.auth_time } : {}),
  };
}

async function exchangeGithub(
  provider: GithubProvider,
  input: ExchangeInput,
): Promise<ProviderIdentity> {
  const token = (await providerFetchJson(
    provider.tokenUrl,
    { method: 'POST', headers: FORM, body: tokenRequestBody(provider, input) },
    provider.timeoutMs,
  )) as { access_token?: unknown; error?: unknown } | null;
  // GitHub answers 200 with `{ error }` on a bad/expired code: that is a failure (F2).
  if (!token || token.error !== undefined || typeof token.access_token !== 'string') {
    throw new FederationError('provider_unavailable');
  }
  const api = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token.access_token}`,
    'User-Agent': 'veyrigate-idp',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const user = (await providerFetchJson(
    provider.userUrl,
    { headers: api },
    provider.timeoutMs,
  )) as {
    id?: unknown;
  } | null;
  // The numeric id is stable; `login` can be renamed and must never be the key (F2).
  if (typeof user?.id !== 'number' || !Number.isSafeInteger(user.id)) {
    throw new FederationError('invalid_identity');
  }
  const emails = await providerFetchJson(provider.emailsUrl, { headers: api }, provider.timeoutMs);
  if (!Array.isArray(emails)) throw new FederationError('provider_unavailable');
  const primary = (emails as { email?: unknown; primary?: unknown; verified?: unknown }[]).find(
    (e) => e?.primary === true && e?.verified === true && typeof e?.email === 'string',
  );
  return {
    providerId: String(user.id),
    ...(primary ? { email: primary.email as string } : {}),
  };
}
