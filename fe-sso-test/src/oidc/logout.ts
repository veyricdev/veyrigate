import type { Discovery } from "./discovery";
import type { TokenStore } from "./tokenStore";
import type { TransientStore } from "./transient";
import { randomUrlToken } from "./random";

export interface LogoutConfig {
  readonly postLogoutRedirectUri: string;
}

/** sessionStorage key holding the pending logout `state` for post-logout verification. */
const LOGOUT_STATE_KEY = "oidc:logout_state";

/**
 * Build the RP-initiated logout URL (spec §9.8 / OIDC RP-Initiated Logout) from
 * `end_session_endpoint`. Includes `id_token_hint` (the ID token — the only token allowed in
 * a URL, by the spec), `post_logout_redirect_uri`, and an optional `state` (CSRF/correlation so
 * the post-logout redirect can be proven to come from the IdP). Returns `null` when there is no
 * session.
 *
 * The access/refresh tokens are NEVER placed in the URL (exposure budget). Call `logout` to also
 * clear the in-memory session before navigating.
 */
export function buildLogoutUrl(
  discovery: Discovery,
  config: LogoutConfig,
  idTokenHint: string | null,
  state?: string,
): string | null {
  if (!idTokenHint) return null;
  const url = new URL(discovery.end_session_endpoint);
  url.searchParams.set("id_token_hint", idTokenHint);
  url.searchParams.set("post_logout_redirect_uri", config.postLogoutRedirectUri);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Clear the in-memory session and return the RP-initiated logout URL (or `null` if already
 * anonymous). A fresh `state` is generated, persisted to `store`, and echoed in the URL so the
 * post-logout redirect can be verified via {@link consumeLogoutState}. After this call the token
 * store is empty.
 */
export function logout(
  discovery: Discovery,
  config: LogoutConfig,
  tokens: TokenStore,
  store?: TransientStore,
  deps: { crypto?: Crypto } = {},
): string | null {
  const session = tokens.get();
  const idTokenHint = session?.idToken ?? null;
  let state: string | undefined;
  if (idTokenHint && store) {
    state = randomUrlToken(32, deps.crypto ?? globalThis.crypto);
    store.setItem(LOGOUT_STATE_KEY, state);
  }
  const url = buildLogoutUrl(discovery, config, idTokenHint, state);
  tokens.clear();
  return url;
}

/**
 * Read and delete the pending logout `state`, returning `true` when `received` matches it. Used
 * on the post-logout landing to confirm the redirect originated from the IdP. Returns `false`
 * (fail-closed) when no state was pending or it does not match; always consumes it (one-shot).
 */
export function consumeLogoutState(store: TransientStore, received: string | null): boolean {
  const expected = store.getItem(LOGOUT_STATE_KEY);
  store.removeItem(LOGOUT_STATE_KEY);
  return expected !== null && received !== null && received === expected;
}
