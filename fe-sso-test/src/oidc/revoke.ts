import { fetchWithTimeout, type FetchFn } from "./http";

/**
 * Best-effort revoke a refresh token (RFC 7009, BE `POST /revoke`). Public client: no secret,
 * `client_id` in the body. This is called just before the wrong-`aud` probe redirects away, so a
 * family is not left orphaned when we abandon the current session. It is BEST-EFFORT by design:
 * any failure (network, CORS, non-2xx, timeout) is swallowed and `false` returned — the caller
 * continues the probe regardless. The token travels only in the POST body (never the URL/log).
 */
export async function revokeRefreshToken(
  revocationEndpoint: string,
  refreshToken: string,
  clientId: string,
  fetchImpl: FetchFn = fetch,
): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(fetchImpl, revocationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        token: refreshToken,
        token_type_hint: "refresh_token",
        client_id: clientId,
      }).toString(),
      credentials: "omit",
      cache: "no-store",
    });
    return res.ok;
  } catch {
    // Best-effort: never block or surface the probe on a revoke failure.
    return false;
  }
}
