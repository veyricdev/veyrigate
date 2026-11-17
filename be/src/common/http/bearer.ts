import type { HttpRequest } from './http.types';

/**
 * The `Bearer` token from the single `Authorization` header (RFC 6750 §2.1), scheme matched
 * case-insensitively. Shared by `/userinfo` and `/demo/me` so the two resource endpoints cannot
 * drift on a hand-copied regex (tech-lead note, Task 1).
 *
 * Returns `undefined` for: no header, a repeated (array) header (malformed), a non-`Bearer`
 * scheme, or an empty credential. The access token is NEVER taken from the query string or body
 * (an access token in a URL leaks into logs/referrers) — only this header is consulted.
 */
export function bearerToken(req: HttpRequest): string | undefined {
  const raw = req.headers['authorization'];
  if (Array.isArray(raw)) {
    return undefined; // a repeated Authorization header is malformed - reject.
  }
  if (!raw) {
    return undefined;
  }
  // Linear parse (CodeQL #1): `Bearer` + >= 1 space + >= 1 more char, no line terminator, trimmed.
  // Same accepted set as the former `/^Bearer[ ]+(.+)$/i`, without its O(n^2) backtracking.
  if (!/^bearer $/i.test(raw.slice(0, 7))) return undefined;
  const rest = raw.slice(7);
  if (rest.length === 0 || /[\n\r\u2028\u2029]/.test(rest)) return undefined;
  return rest.trim();
}
