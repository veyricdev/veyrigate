import type { Discovery } from "./discovery";
import { postToken } from "./token-exchange";
import { validateIdToken, type IdTokenPolicy } from "./idToken";
import {
  clearTransient,
  isTransientStale,
  readTransient,
  type TransientStore,
} from "./transient";
import type { TokenStore, Session } from "./tokenStore";
import type { FetchFn } from "./http";

export interface CallbackConfig {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly issuer: string;
}

export interface CallbackDeps {
  readonly discovery: Discovery;
  readonly store: TransientStore;
  readonly tokens: TokenStore;
  readonly jwks: IdTokenPolicy["jwks"];
  readonly fetchImpl?: FetchFn;
  readonly now?: () => number;
}

/** In-flight exchange keyed by `code` so StrictMode's double-invoke exchanges once (F2). */
const inFlight = new Map<string, Promise<Session>>();

/** OAuth 2.0 / OIDC error codes we surface verbatim (RFC 6749 §4.1.2.1, OIDC Core §3.1.2.6). */
const KNOWN_ERROR_CODES = new Set([
  "access_denied",
  "invalid_request",
  "unauthorized_client",
  "unsupported_response_type",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
  "interaction_required",
  "login_required",
  "account_selection_required",
  "consent_required",
  "invalid_request_uri",
  "invalid_request_object",
  "request_not_supported",
  "request_uri_not_supported",
  "registration_not_supported",
]);

/**
 * Build a user-facing message for an IdP error WITHOUT echoing `error_description` (content
 * spoofing: an attacker can craft `/callback?error=...&error_description=<lure>`). We show a
 * fixed message plus the `error` code only — whitelisted codes verbatim, anything else sanitised
 * to `[a-z0-9_-]` and truncated — and mark clearly that it came from the identity provider.
 */
function describeIdpError(error: string): string {
  const code = KNOWN_ERROR_CODES.has(error)
    ? error
    : error.replace(/[^a-z0-9_-]/gi, "").slice(0, 64) || "unknown";
  return `Sign-in was not completed. The identity provider returned error: ${code}`;
}

/**
 * Handle the `/callback` query and finish login (spec §9.1/§9.2, INV-6/-7/-9).
 *
 * Order (fail-closed): surface IdP `error`; require matching `state` (CSRF, INV); require `iss`
 * present and === issuer (mix-up, F5/RFC 9207); reject stale transient (F6); then exchange the
 * code. The transient is deleted BEFORE the exchange (F2) so a StrictMode re-render cannot reuse
 * it; concurrent exchanges of the same `code` share one request. The ID token is validated with
 * the callback `nonce` before any session is stored.
 */
export async function handleCallback(
  params: URLSearchParams,
  config: CallbackConfig,
  deps: CallbackDeps,
): Promise<Session> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;

  const error = params.get("error");
  if (error) {
    // Clear the transient on the IdP-error branch too (OPEN-1): the login attempt is over,
    // so {state, nonce, code_verifier} must not linger until the next login overwrites them.
    clearTransient(deps.store);
    throw new Error(describeIdpError(error));
  }

  const code = params.get("code");
  const state = params.get("state");
  const iss = params.get("iss");
  if (!code || !state) {
    // Clear the transient when the response is malformed (OPEN-1): no exchange will happen.
    clearTransient(deps.store);
    throw new Error("Authorization response is missing code or state");
  }

  // Single-flight by code BEFORE touching the transient (F2): StrictMode invokes the effect
  // twice in dev, so the second call must join the first in-flight exchange rather than re-read
  // a transient the first call already deleted.
  const existing = inFlight.get(code);
  if (existing) return existing;

  const task = exchange(code, state, iss, config, deps, fetchImpl, now);
  inFlight.set(code, task);
  try {
    return await task;
  } finally {
    inFlight.delete(code);
  }
}

async function exchange(
  code: string,
  state: string,
  iss: string | null,
  config: CallbackConfig,
  deps: CallbackDeps,
  fetchImpl: FetchFn,
  now: () => number,
): Promise<Session> {
  const transient = readTransient(deps.store);
  // Delete the transient immediately on reading it (OPEN-1/F2): it is consumed exactly once, so
  // every branch below — mismatch, stale, or the exchange — leaves nothing to replay or linger.
  clearTransient(deps.store);
  if (!transient) {
    throw new Error("No login in progress (missing transient); cannot verify state");
  }
  if (state !== transient.state) {
    throw new Error("state mismatch: possible CSRF; rejecting callback");
  }
  // F5: iss is mandatory (BE advertises authorization_response_iss_parameter_supported) and must
  // match the configured issuer.
  if (!iss || iss !== config.issuer) {
    throw new Error("iss missing or mismatched: possible mix-up; rejecting callback");
  }
  if (isTransientStale(transient, now())) {
    throw new Error("Login attempt expired; please start again");
  }

  const verifier = transient.verifier;
  const expectedNonce = transient.nonce;

  const token = await postToken(
    deps.discovery.token_endpoint,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      code_verifier: verifier,
    },
    fetchImpl,
  );
  if (!token.id_token) {
    throw new Error("Token response missing id_token");
  }
  const policy: IdTokenPolicy = {
    issuer: config.issuer,
    audience: config.clientId,
    jwks: deps.jwks,
  };
  const claims = await validateIdToken(token.id_token, policy, { expectedNonce });
  const session: Session = {
    accessToken: token.access_token,
    idToken: token.id_token,
    refreshToken: token.refresh_token,
    claims,
    accessTokenExpiresAt: now() + token.expires_in * 1000,
  };
  deps.tokens.set(session);
  return session;
}
