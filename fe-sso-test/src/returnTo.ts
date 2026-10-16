/**
 * Strict `returnTo` validation for the login round-trip (Task 2, run 24). The post-login
 * destination is an UNTRUSTED input: it arrives from the URL (`/login?returnTo=...`) and is
 * persisted across the redirect in a sessionStorage transient. Both the transient and the query
 * are attacker-controllable, so we validate on BOTH write and read.
 *
 * Only a same-origin internal PATH is ever accepted (open-redirect defence): the value must begin
 * with a single `/`, must not begin with `//` or `/\` (protocol-relative / backslash tricks), must
 * not contain a backslash or any control character, must carry no scheme, and must resolve to the
 * current origin. Anything else collapses to the safe default `/`.
 */

/** The safe fallback destination when a candidate `returnTo` fails validation. */
export const DEFAULT_RETURN_TO = "/";

// eslint-disable-next-line no-control-regex -- intentionally match C0/C1 controls + DEL to reject them.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Percent-encoded slash/backslash (`%2f`, `%5c`) could decode to `//`, `/\`, or embed a path
 * separator after normalisation — treat the whole leading segment as a protocol-relative trick
 * and reject. We only guard the first path segment (up to `?`/`#`) so legitimately-encoded query
 * values are not blocked.
 */
const ENCODED_SEPARATOR = /%2f|%5c/i;

/**
 * Return `true` only when `value` is a safe same-origin internal path.
 *
 * `origin` defaults to the live `window.location.origin`; it is injectable so unit tests run
 * without a real DOM. Rejects (fail-closed) anything that is not a plain string, does not start
 * with `/`, starts with `//` or `/\`, contains `\` or a control char, or whose parsed origin does
 * not equal `origin`. A scheme (e.g. `javascript:`, `https:`) never starts with `/`, so those are
 * rejected by the leading-slash rule; the `new URL` origin check is defence-in-depth.
 */
export function isSafeReturnTo(value: unknown, origin?: string): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  if (value[0] !== "/") return false; // must be an absolute-path reference, not a scheme/host
  if (value[1] === "/" || value[1] === "\\") return false; // `//host` or `/\host`
  if (value.includes("\\")) return false; // no backslashes anywhere (browsers may normalise to `/`)
  if (CONTROL_CHARS.test(value)) return false; // no C0/C1/DEL (CR/LF/NUL smuggling)

  // Reject encoded path separators in the path portion (before any `?`/`#`): `/%2F%2Fevil` etc.
  const pathPart = value.split(/[?#]/, 1)[0];
  if (ENCODED_SEPARATOR.test(pathPart)) return false;

  const base = origin ?? safeOrigin();
  if (base === null) return false;
  try {
    const url = new URL(value, base);
    return url.origin === base;
  } catch {
    return false;
  }
}

/**
 * Coerce an untrusted candidate to a safe path: the value itself when {@link isSafeReturnTo}, else
 * {@link DEFAULT_RETURN_TO}. Use on both WRITE (before storing) and READ (before navigating).
 */
export function sanitizeReturnTo(value: unknown, origin?: string): string {
  return isSafeReturnTo(value, origin) ? value : DEFAULT_RETURN_TO;
}

/** Read `window.location.origin` without throwing when `window` is absent (node test env). */
function safeOrigin(): string | null {
  if (typeof window === "undefined" || !window.location) return null;
  return window.location.origin;
}