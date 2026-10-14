import type { IdTokenClaims } from "./types";

/**
 * In-memory session (OPEN-1 / F7). Access, ID, and refresh tokens live ONLY in this closure —
 * never localStorage/sessionStorage, never a cookie, never a URL. A page reload drops the
 * session (user becomes anonymous), which is the accepted trade-off. The raw ID token is kept
 * only as `id_token_hint` for RP-initiated logout; the access token is treated as opaque.
 */
export interface Session {
  readonly accessToken: string;
  readonly idToken: string;
  readonly refreshToken?: string;
  readonly claims: IdTokenClaims;
  /** Absolute epoch-ms expiry derived from `expires_in` at receipt (for countdown/refresh). */
  readonly accessTokenExpiresAt: number;
}

export interface TokenStore {
  get(): Session | null;
  set(session: Session): void;
  clear(): void;
}

/** Create a fresh in-memory token store. Nothing is persisted outside this closure. */
export function createTokenStore(): TokenStore {
  let session: Session | null = null;
  return {
    get: () => session,
    set: (s) => {
      session = s;
    },
    clear: () => {
      session = null;
    },
  };
}
