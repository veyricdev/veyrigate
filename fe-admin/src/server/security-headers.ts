import "@tanstack/react-start/server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { logServerError } from "./errors";

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
 * DEBT-446: a `Location` is either a relative reference without authority or an absolute URL whose
 * origin is one of `origins`, without userinfo. Anything else (or unparsable) is refused.
 */
function allowedLocation(loc: string, origins: Set<string>): boolean {
  try {
    const absolute = URL.canParse(loc);
    const u = absolute ? new URL(loc) : new URL(loc, "http://base.invalid");
    const originOk = absolute ? origins.has(u.origin) : u.origin === "http://base.invalid";
    return originOk && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}

/**
 * Runs `handle` with a fresh nonce and returns its response with the security headers. The body
 * stream is forwarded untouched and every `Set-Cookie` kept; the original headers are copied, never
 * mutated (a `Response.redirect` has immutable headers). Last line of defence (DEBT-446): a response
 * whose `Location` leaves the origins of `appUrl`/`issuer` becomes a plain 404 without its headers.
 */
export async function withSecurityHeaders(
  handle: () => Response | Promise<Response>,
  { appUrl, issuer }: { appUrl?: string; issuer?: string } = {},
): Promise<Response> {
  const nonce = randomBytes(16).toString("base64");
  let res: Response;
  try {
    res = await requestNonce.run({ nonce }, handle);
  } catch (err) {
    // DEBT-368: a throw would reach the host's bare 500 without these headers. Logged with a
    // request id (name + message only); the response stays fixed text.
    logServerError("server entry", err);
    res = new Response("Internal Server Error", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const loc = res.headers.get("location");
  if (loc !== null) {
    const origins = new Set([appUrl, issuer].filter((x) => x !== undefined).map((x) => new URL(x).origin));
    if (!allowedLocation(loc, origins)) {
      res.body?.cancel().catch(() => {});
      logServerError("location guard", new Error(`blocked an off-origin Location (status ${res.status})`));
      res = new Response("Not Found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
  }
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
