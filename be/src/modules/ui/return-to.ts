/**
 * Extract the `request_id` from an already-`safeReturnTo`-sanitised login return URL, but ONLY when
 * it is exactly `/authorize?request_id=<id>` — path `/authorize` with a single query key
 * `request_id` (DEBT-084). Any other path, extra query parameter (e.g. a smuggled `redirect_uri`),
 * or missing/empty id returns null. Used only to look up the resumable context origin for the
 * per-response CSP `form-action`; it never widens the redirect set.
 */
export function requestIdFromReturnTo(safeReturn: string): string | null {
  const q = safeReturn.indexOf('?');
  if (q === -1) return null;
  if (safeReturn.slice(0, q) !== '/authorize') return null;
  const params = new URLSearchParams(safeReturn.slice(q + 1));
  const keys = [...params.keys()];
  if (keys.length !== 1 || keys[0] !== 'request_id') return null;
  const requestId = params.get('request_id');
  return requestId && requestId.length > 0 ? requestId : null;
}

export function safeReturnTo(value: unknown, issuer: string): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    /[\r\n]|%0d|%0a/i.test(value)
  )
    return '/';
  try {
    return new URL(value, issuer).origin === new URL(issuer).origin ? value : '/';
  } catch {
    return '/';
  }
}
