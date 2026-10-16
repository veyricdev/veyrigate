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
  const match = /^Bearer[ ]+(.+)$/i.exec(raw);
  return match ? match[1].trim() : undefined;
}
