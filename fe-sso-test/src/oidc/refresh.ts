import type { Discovery } from "./discovery";
import { postToken } from "./token-exchange";
import { validateIdToken, type IdTokenPolicy } from "./idToken";
import type { TokenStore, Session } from "./tokenStore";
import type { FetchFn } from "./http";

export interface RefreshConfig {
  readonly clientId: string;
  readonly issuer: string;
}

export interface RefreshDeps {
  readonly discovery: Discovery;
  readonly tokens: TokenStore;
  readonly jwks: IdTokenPolicy["jwks"];
  readonly fetchImpl?: FetchFn;
  readonly now?: () => number;
}

/**
 * Single-flight refresh (F3). Concurrent callers share ONE `/token` request, so rotating
 * refresh tokens never trigger the BE's reuse-detection (which would revoke the whole family).
 * Kept per store instance via this WeakMap.
 */
const inFlight = new WeakMap<TokenStore, Promise<Session>>();

/**
 * Exchange the stored refresh token for a fresh session (B4.5, rotation). On success the new
 * tokens (including a rotated `refresh_token`, if any) replace the old ones and the old refresh
 * token is dropped. The refreshed ID token is validated in refresh mode (F4): no `nonce`, same
 * `sub`. Any failure (`invalid_grant`, timeout, invalid token) clears the session fail-closed
 * — back to anonymous, NO automatic retry.
 */
export async function refreshSession(
  config: RefreshConfig,
  deps: RefreshDeps,
): Promise<Session> {
  const existing = inFlight.get(deps.tokens);
  if (existing) return existing;

  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;

  const current = deps.tokens.get();
  if (!current?.refreshToken) {
    throw new Error("No refresh_token available; cannot refresh");
  }
  const previousSub = current.claims.sub;
  const refreshToken = current.refreshToken;

  const task = (async (): Promise<Session> => {
    const token = await postToken(
      deps.discovery.token_endpoint,
      {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: config.clientId,
      },
      fetchImpl,
    );

    const policy: IdTokenPolicy = {
      issuer: config.issuer,
      audience: config.clientId,
      jwks: deps.jwks,
    };
    // The refreshed ID token may be omitted; reuse the prior one for the logout hint if so.
    const idToken = token.id_token ?? current.idToken;
    const claims = token.id_token
      ? await validateIdToken(token.id_token, policy, { previousSub })
      : current.claims;

    const session: Session = {
      accessToken: token.access_token,
      idToken,
      refreshToken: token.refresh_token,
      claims,
      accessTokenExpiresAt: now() + token.expires_in * 1000,
    };
    // Don't resurrect a session that was logged out (or replaced) while this refresh was in
    // flight: only commit if the store still holds exactly the session we started from. After
    // `logout()` cleared it, `get()` is `null`, so we return the refreshed tokens WITHOUT writing
    // them back — the user stays signed out and any newer session is left untouched.
    if (deps.tokens.get() === current) {
      deps.tokens.set(session);
    }
    return session;
  })();

  inFlight.set(deps.tokens, task);
  try {
    return await task;
  } catch (err) {
    deps.tokens.clear(); // fail-closed: drop everything, become anonymous
    throw err;
  } finally {
    inFlight.delete(deps.tokens);
  }
}
