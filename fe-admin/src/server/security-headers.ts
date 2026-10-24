import "@tanstack/react-start/server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/**
 * A7 (DEBT-269/266/298): every response that goes through the server entry gets a strict CSP with a
 * fresh per-response script nonce, plus the other security headers. The nonce lives in a store for
 * the request so `getRouter()` (called lazily inside `handler.fetch`) can hand it to the router,
 * which puts it on every SSR/stream script. Never logged, never in an error message.
 */
const requestNonce = new AsyncLocalStorage<{ nonce: string }>();

/** The nonce of the current request, `undefined` outside one (never throws). */
export function currentCspNonce(): string | undefined {
  return requestNonce.getStore()?.nonce;
}

function contentSecurityPolicy(nonce: string, issuer: string | undefined): string {
  // `form-action` needs the issuer: logout answers 303 to its end_session endpoint, and Chrome
  // applies form-action to the redirect after a submit. `style-src 'unsafe-inline'`: DEBT-361.
  const formAction = issuer ? `'self' ${new URL(issuer).origin}` : "'self'";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    `form-action ${formAction}`,
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * Runs `handle` with a fresh nonce and returns its response with the security headers. The body
 * stream is forwarded untouched and every `Set-Cookie` kept; the original headers are copied, never
 * mutated (a `Response.redirect` has immutable headers).
 */
export async function withSecurityHeaders(
  handle: () => Response | Promise<Response>,
  { appUrl, issuer }: { appUrl?: string; issuer?: string } = {},
): Promise<Response> {
  const nonce = randomBytes(16).toString("base64");
  const res = await requestNonce.run({ nonce }, handle);
  const headers = new Headers(res.headers);
  headers.set("content-security-policy", contentSecurityPolicy(nonce, issuer));
  headers.set("x-frame-options", "DENY");
  headers.set("x-content-type-options", "nosniff");
  // Not no-referrer: a same-origin form POST would then send `Origin: null` (logout/CSRF checks).
  headers.set("referrer-policy", "same-origin");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  headers.set("cross-origin-opener-policy", "same-origin");
  if (appUrl?.startsWith("https:")) headers.set("strict-transport-security", "max-age=31536000");
  // A page carrying a nonce must never be served from a cache.
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
