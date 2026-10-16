import { sanitizeReturnTo } from "../returnTo";
import type { TransientStore } from "./transient";

/**
 * Transient carrier for the post-login `returnTo` path (Task 2, run 24). It is persisted in
 * sessionStorage across the `/authorize` redirect — deliberately NOT through the OAuth `state`
 * parameter (which is reserved for CSRF defence and travels to the IdP). Tokens are never stored
 * here. Both the WRITE (`saveReturnTo`) and the READ (`takeReturnTo`) sanitize the value, because
 * sessionStorage is an untrusted input (another tab / prior navigation could have seeded it).
 */
const RETURN_TO_KEY = "oidc:return_to";

/**
 * Persist a sanitized `returnTo` for after login. A value that fails validation is normalised to
 * `/` before being stored (never persist an unsafe path). `origin` is injectable for tests.
 */
export function saveReturnTo(store: TransientStore, candidate: unknown, origin?: string): void {
  store.setItem(RETURN_TO_KEY, sanitizeReturnTo(candidate, origin));
}

/**
 * Read, delete, and re-sanitize the pending `returnTo` (one-shot). Returns a guaranteed-safe path
 * (`/` when absent or invalid). The value is validated AGAIN on read so a tampered transient can
 * never redirect off-origin.
 */
export function takeReturnTo(store: TransientStore, origin?: string): string {
  const raw = store.getItem(RETURN_TO_KEY);
  store.removeItem(RETURN_TO_KEY);
  return sanitizeReturnTo(raw, origin);
}