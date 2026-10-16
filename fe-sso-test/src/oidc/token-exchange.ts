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

/** OAuth 2.0 token-error codes we surface verbatim (RFC 6749 §5.2). */
const KNOWN_TOKEN_ERROR_CODES = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
]);

/**
 * Sanitise a `/token` error code WITHOUT echoing `error_description` (content spoofing: the IdP
 * — or an attacker able to craft the response — controls that free-text field). Whitelisted codes
 * pass through verbatim; anything else is reduced to `[a-z0-9_-]` and truncated. Mirrors
 * `describeIdpError` in callback.ts (DEBT-080).
 */
function sanitizeTokenError(error: string): string {
  return KNOWN_TOKEN_ERROR_CODES.has(error)
    ? error
    : error.replace(/[^a-z0-9_-]/gi, "").slice(0, 64) || "unknown";
}

/**
 * A non-2xx `/token` response, carrying the sanitised OAuth `error` code (or `http_<status>` when
 * the body has none) as a structured field so callers (the security lab, run 25 F6) can tell
 * `invalid_grant` apart from 5xx without parsing the message. The message is unchanged.
 */
export class TokenEndpointError extends Error {
  constructor(readonly code: string) {
    super(`Token endpoint error (${code})`);
    this.name = "TokenEndpointError";
  }
}

/**
 * POST to `/token`. Public client (PKCE, no secret): no auth header, `client_id` in the body.
 * NO retry (F6): the authorization_code grant consumes a one-time code; a retry would hit
 * `invalid_grant`. On a non-2xx the OAuth error is surfaced fail-closed — the sanitised `error`
 * code only, never the attacker/IdP-controlled `error_description` (DEBT-080).
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
    const code =
      typeof json.error === "string" ? sanitizeTokenError(json.error) : `http_${res.status}`;
    throw new TokenEndpointError(code);
  }
  const parsed = TokenSuccess.safeParse(json);
  if (!parsed.success) {
    throw new Error("Token endpoint returned a malformed success response");
  }
  return parsed.data as TokenResponse;
}
