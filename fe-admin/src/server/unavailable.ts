import "@tanstack/react-start/server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * DEBT-282: the router only knows 200/404/500 for an SSR page, so a page whose loader/guard hit a
 * dead dependency (Redis, IdP) would answer 500. Each request runs in a store; the error boundary
 * flags it when it maps an error to 503, and the server entry turns that request's 500 into 503.
 */
const requestState = new AsyncLocalStorage<{ unavailable: boolean }>();

/** Called by the error boundary when it answers 503 (no-op outside a request). */
export function markUnavailable(): void {
  const state = requestState.getStore();
  if (state) state.unavailable = true;
}

/** Runs `handle` in a fresh store; a 500 is re-labelled 503 when the request was flagged. */
export async function withUnavailableStatus(handle: () => Response | Promise<Response>): Promise<Response> {
  const state = { unavailable: false };
  const res = await requestState.run(state, handle);
  if (!state.unavailable || res.status !== 500) return res;
  // Forward the body stream untouched (never read it); same headers, never cached.
  const headers = new Headers(res.headers);
  headers.set("cache-control", "no-store");
  return new Response(res.body, { status: 503, statusText: "Service Unavailable", headers });
}
