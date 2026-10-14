import { z } from "zod";
import { fetchWithTimeout, type FetchFn } from "./http";
import type { TokenResponse } from "./types";

/**
 * Minimal success-shape guard for `/token` (spec §9.2). A malformed response would otherwise
 * produce a session with `undefined` tokens or `NaN` expiry; validating fail-closed turns that
 * into a thrown error instead. `refresh_token`/`id_token` are optional per grant.
 */
const TokenSuccess = z.object({
  access_token: z.string().min(1),
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z.number().finite(),
  id_token: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});

/**
 * POST to `/token`. Public client (PKCE, no secret): no auth header, `client_id` in the body.
 * NO retry (F6): the authorization_code grant consumes a one-time code; a retry would hit
 * `invalid_grant`. On a non-2xx the OAuth error is surfaced fail-closed.
 */
export async function postToken(
  tokenEndpoint: string,
  body: Record<string, string>,
  fetchImpl: FetchFn,
): Promise<TokenResponse> {
  const res = await fetchWithTimeout(fetchImpl, tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body).toString(),
  });

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof json.error === "string" ? json.error : `http_${res.status}`;
    const desc = typeof json.error_description === "string" ? `: ${json.error_description}` : "";
    throw new Error(`Token endpoint error (${code})${desc}`);
  }
  const parsed = TokenSuccess.safeParse(json);
  if (!parsed.success) {
    throw new Error("Token endpoint returned a malformed success response");
  }
  return parsed.data as TokenResponse;
}
