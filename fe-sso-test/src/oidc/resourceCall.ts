import { type FetchFn } from "./http";

/** Hard timeout for a resource call (Task 3 / spec §258): a hung endpoint must not hang the UI. */
export const RESOURCE_CALL_TIMEOUT_MS = 10_000;

/** Result of a protected-resource call: HTTP status + the parsed JSON body (never the token). */
export interface ResourceResult {
  readonly status: number;
  /** Parsed JSON body (metadata/claims only). `null` when the body was empty/not JSON. */
  readonly body: unknown;
}

/**
 * Error raised when the resource call never produced an HTTP status: a network failure, a CORS
 * block (the browser surfaces these as a thrown `TypeError`), or the 10s timeout. The UI shows a
 * generic "network error" for this — there is no status to score pass/fail against (fail-closed).
 */
export class ResourceNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceNetworkError";
  }
}

/**
 * Call a protected resource with a Bearer access token and return its HTTP status + JSON body
 * (INV-8 / exposure budget):
 *  - `Authorization: Bearer <access token>` — the token travels ONLY in the header, never in the
 *    URL/body/log.
 *  - `credentials: "omit"` — no ambient cookies cross the FE→BE origin boundary; the Bearer token
 *    is the sole credential (the probe must stand on the token alone, not the IdP session cookie).
 *  - `cache: "no-store"` — never serve a stale authorization decision.
 *  - hard `AbortSignal.timeout` — a hung endpoint rejects instead of hanging the flow.
 *
 * Any non-HTTP failure (network down, CORS block, timeout) is normalised to a
 * {@link ResourceNetworkError}; an HTTP response (any status, including 401) resolves with its
 * status so the caller can score pass/fail against the EXPECTED status code.
 */
export async function callResource(
  url: string,
  accessToken: string,
  fetchImpl: FetchFn = fetch,
  timeoutMs = RESOURCE_CALL_TIMEOUT_MS,
): Promise<ResourceResult> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new ResourceNetworkError(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    // `fetch` rejects with a TypeError on network failure / CORS block — no status to report.
    throw new ResourceNetworkError(`Request to ${url} failed (network or CORS error)`);
  }
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}
