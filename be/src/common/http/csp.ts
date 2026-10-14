/**
 * Single source of truth for the Content-Security-Policy header (DEBT-084).
 *
 * `buildCsp()` with no arguments renders the EXACT same header helmet emits globally (`main.ts` +
 * helmet 8 defaults): same directives, same order, same `;` separator. Acceptance #8 asserts this
 * byte-identity against a live app response, so the constant below must track the helmet config.
 *
 * A handful of GET routes render a form whose submission ends in a cross-origin redirect to a
 * relying party (`/login`, consent, `/logout`). Chromium applies the `form-action` of the document
 * that CONTAINS the form to every navigation step of the form submission, so helmet's global
 * `form-action 'self'` blocks those redirects. Those routes call `buildCsp({ formAction })` with the
 * single RP origin that was ALREADY exact-matched against the client server-side (never the raw
 * `redirect_uri`/`returnTo`), relaxing only `form-action` for that one response (INV-084-1/2).
 *
 * The front-channel logout page (`renderFrontchannel`) likewise relaxes only `frame-src`.
 */

/** Ordered base directives, byte-identical to the global helmet CSP (helmet 8, `main.ts`). */
const BASE_DIRECTIVES: ReadonlyArray<readonly [name: string, value: string]> = [
  ['default-src', "'self'"],
  ['base-uri', "'self'"],
  ['font-src', "'self' https: data:"],
  ['form-action', "'self'"],
  ['frame-ancestors', "'none'"],
  ['img-src', "'self' data:"],
  ['object-src', "'none'"],
  ['script-src', "'self'"],
  ['script-src-attr', "'none'"],
  ['style-src', "'self'"],
  ['upgrade-insecure-requests', ''],
];

export interface BuildCspOptions {
  /** Extra sources appended to `form-action` (origins only; base `'self'` is always kept first). */
  formAction?: string[];
  /** `frame-src` sources; when present a `frame-src` directive is added (helmet has no default). */
  frameSrc?: string[];
}

/**
 * Render the CSP header value. Only `form-action` (extra origins appended after `'self'`) and
 * `frame-src` (added when `frameSrc` is non-empty) ever differ from the global header; every other
 * directive is emitted verbatim in helmet's order (INV-084-2). Empty option arrays render the base
 * header unchanged so `buildCsp()` === the global header.
 */
export function buildCsp(options: BuildCspOptions = {}): string {
  const formActionExtra = dedupe(options.formAction ?? []);
  const frameSrc = dedupe(options.frameSrc ?? []);
  const parts: string[] = [];
  for (const [name, value] of BASE_DIRECTIVES) {
    if (name === 'form-action') {
      parts.push(joinDirective(name, [value, ...formActionExtra]));
    } else {
      parts.push(value ? `${name} ${value}` : name);
    }
    // Keep `frame-src` next to `frame-ancestors`, matching `renderFrontchannel`'s historic slot.
    if (name === 'frame-ancestors' && frameSrc.length > 0) {
      parts.push(joinDirective('frame-src', frameSrc));
    }
  }
  return parts.join(';');
}

function joinDirective(name: string, sources: string[]): string {
  return `${name} ${sources.filter((s) => s.length > 0).join(' ')}`;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Second defence layer (after the redirect-URI validator) for turning a stored, already-matched URI
 * into a bare CSP origin. Returns `null` — so the caller falls back to `'self'` (fail-closed) — when
 * the URI is unparseable, has a `null`/opaque origin, is not http(s), or carries any character that
 * could split the header (`;`, `,`, whitespace). Only the origin is returned (never path/query).
 */
export function safeCspOrigin(uri: string | undefined | null): string | null {
  if (typeof uri !== 'string' || uri.length === 0) return null;
  let origin: string;
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    origin = parsed.origin;
  } catch {
    return null;
  }
  // `origin` is `'null'` for opaque origins; reject it and anything that is not a clean http(s)
  // origin (host + optional port only) so a hand-edited/legacy URI can never split the header.
  if (origin === 'null') return null;
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(origin)) return null;
  return origin;
}
