/** Shared fetch timeout for every OIDC network call (discovery/token/JWKS) — F6. */
export const OIDC_FETCH_TIMEOUT_MS = 10_000;

/** Injectable fetch so tests never touch the network. Matches the global `fetch` shape. */
export type FetchFn = typeof fetch;

/**
 * Fetch with a hard `AbortSignal.timeout` (F6). A hung endpoint rejects with a clear timeout
 * error rather than hanging the flow forever. No retry is applied here — callers that must not
 * retry (e.g. the authorization_code `/token` exchange) simply call once.
 */
export async function fetchWithTimeout(
  fetchImpl: FetchFn,
  input: string,
  init: RequestInit = {},
  timeoutMs = OIDC_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetchImpl(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`OIDC request to ${input} timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}
