import "@tanstack/react-start/server-only";

/**
 * Post-login destination allowlist (ported from fe-sso-test `returnTo.ts`, run 42 fold): a relative
 * path starting with exactly one `/`; no `//`, `/\`, backslash, control chars or encoded separators
 * in the path; same origin as APP_URL; never under `/auth/`; at most 512 chars. Anything else => `/`.
 * Applied when the value is stored (login) and again when it is read back (callback).
 */
// eslint-disable-next-line no-control-regex -- reject C0/C1 controls + DEL on purpose.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const ENCODED_SEPARATOR = /%2f|%5c/i;

export function sanitizeReturnTo(value: unknown, appUrl: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return "/";
  if (value[0] !== "/" || value[1] === "/" || value[1] === "\\") return "/";
  if (value.includes("\\") || CONTROL_CHARS.test(value)) return "/";
  const path = value.split(/[?#]/, 1)[0] ?? "";
  if (ENCODED_SEPARATOR.test(path)) return "/";
  let url: URL;
  try {
    url = new URL(value, appUrl);
  } catch {
    return "/";
  }
  if (url.origin !== appUrl) return "/";
  if (url.pathname === "/auth" || url.pathname.startsWith("/auth/")) return "/";
  return value;
}
