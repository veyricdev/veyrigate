import "@tanstack/react-start/server-only";
import { randomUUID } from "node:crypto";
import { isNotFound, isRedirect } from "@tanstack/react-router";
import { markUnavailable } from "./unavailable";

/**
 * Error boundary for everything that crosses the server -> browser edge (DEBT-275). An unintended
 * error never reaches SSR HTML, a `/_serverFn` response or a server-route body: it is logged here
 * with a request id (name + message only, our own messages carry no token/code/cookie) and replaced
 * by a fixed public message that only carries that id.
 */

/** A dependency (session Redis, IdP) is down: answer 503, keep the session cookie. */
export class ServiceUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ServiceUnavailableError";
  }
}

/** An already-sanitised error (fixed message + request id): passes through boundaries as is. */
export class PublicError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PublicError";
  }
}

const describe = (err: unknown): string => {
  if (!(err instanceof Error)) return typeof err;
  const cause = err.cause instanceof Error ? ` (cause: ${err.cause.name}: ${err.cause.message})` : "";
  return `${err.name}: ${err.message}${cause}`;
};

/** Logs `err` under a fresh request id and returns the id. */
export function logServerError(where: string, err: unknown): string {
  const requestId = randomUUID();
  console.error(`[fe-admin] ${where} failed, request id ${requestId}: ${describe(err)}`);
  return requestId;
}

/**
 * Router control flow (redirect / notFound) passes through untouched; anything else is logged and
 * replaced. `status` is 503 for {@link ServiceUnavailableError}, 500 otherwise.
 */
export function toPublicError(where: string, err: unknown): { error: unknown; status: number } {
  if (isRedirect(err) || isNotFound(err)) return { error: err, status: 0 };
  if (err instanceof PublicError) return { error: err, status: err.status };
  const requestId = logServerError(where, err);
  if (err instanceof ServiceUnavailableError) {
    markUnavailable(); // DEBT-282: an SSR page answers 503, not 500
    return { error: new PublicError(`Service unavailable (request id ${requestId})`, 503), status: 503 };
  }
  return { error: new PublicError(`Internal error (request id ${requestId})`, 500), status: 500 };
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Minimal error page for server routes (/auth/*): no script, no detail, fixed text + a sign-in link.
 * `setCookies` lets the caller clear cookies on the same response.
 */
export function errorPage(status: number, message: string, setCookies: string[] = []): Response {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  for (const c of setCookies) headers.append("set-cookie", c);
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SSO Admin</title></head><body><main><h1>Sign-in problem</h1><p role="alert">${escapeHtml(message)}</p><p><a href="/">Back to the admin console</a></p></main></body></html>`;
  return new Response(body, { status, headers });
}

/** Generic 500/503 page for an unexpected throw (logged with a request id); `setCookies` as above. */
export function unexpectedErrorPage(where: string, err: unknown, setCookies: string[] = []): Response {
  const { status } = toPublicError(where, err);
  return status === 503
    ? errorPage(503, "Service temporarily unavailable. Please try again.", setCookies)
    : errorPage(500, "Something went wrong. Please try again.", setCookies);
}

/** Wraps a server-route handler: an unexpected throw becomes a generic 500/503 page. */
export function withErrorPage<A extends unknown[]>(
  where: string,
  handler: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (err) {
      return unexpectedErrorPage(where, err);
    }
  };
}
