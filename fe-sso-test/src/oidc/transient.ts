/**
 * Redirect-flow transient: the only thing the client persists across the `/authorize` redirect.
 * Holds `state`, `nonce`, PKCE `verifier`, and `createdAt`. Tokens are NEVER stored here
 * (OPEN-1: tokens stay in memory only). The transient is written before redirect and deleted at
 * the callback before the token exchange (F2).
 */
export interface Transient {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  /** Epoch ms when the login began; used to reject stale callbacks (F6, 10-minute cap). */
  readonly createdAt: number;
  /**
   * Why this authorize flow was started. Absent/`"login"` is an ordinary sign-in; `"aud-probe"`
   * marks the wrong-`aud` security-lab flow (Task 3) so the callback runs the probe path instead
   * of installing a session. A persisted value of anything other than `"aud-probe"` is treated as
   * a normal login (fail-closed: an unknown purpose never triggers the probe path).
   */
  readonly purpose?: "login" | "aud-probe";
}

const KEY = "oidc:transient";

/** Max age of a login attempt before its callback is rejected as stale (F6). */
export const TRANSIENT_MAX_AGE_MS = 10 * 60 * 1000;

/** Minimal storage shape (sessionStorage); injectable for tests. */
export interface TransientStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function saveTransient(t: Transient, store: TransientStore): void {
  store.setItem(KEY, JSON.stringify(t));
}

export function readTransient(store: TransientStore): Transient | null {
  const raw = store.getItem(KEY);
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as Transient;
    if (
      typeof t.state === "string" &&
      typeof t.nonce === "string" &&
      typeof t.verifier === "string" &&
      typeof t.createdAt === "number"
    ) {
      return t;
    }
    return null;
  } catch {
    return null;
  }
}

export function clearTransient(store: TransientStore): void {
  store.removeItem(KEY);
}

/** True when the transient is older than `TRANSIENT_MAX_AGE_MS` (stale login attempt). */
export function isTransientStale(t: Transient, now = Date.now()): boolean {
  return now - t.createdAt > TRANSIENT_MAX_AGE_MS;
}
