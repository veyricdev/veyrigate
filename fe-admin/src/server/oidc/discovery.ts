import "@tanstack/react-start/server-only";
import { z } from "zod";
import { ServiceUnavailableError } from "../errors";

export type FetchFn = typeof fetch;

/** fetch with a hard timeout (every IdP / admin API call is time-boxed, run 42 fold). */
export function fetchWithTimeout(
  fetchImpl: FetchFn,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  return fetchImpl(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
}

const DiscoverySchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  jwks_uri: z.url(),
  end_session_endpoint: z.url(),
  userinfo_endpoint: z.url(),
  revocation_endpoint: z.url(),
});

export type Discovery = z.infer<typeof DiscoverySchema>;

const TTL_MS = 60 * 60_000;

/**
 * `{issuer}/.well-known/openid-configuration`, cached in-process for 1 h (ported from
 * fe-sso-test `oidc/discovery.ts`). Fail-closed: `issuer` must equal the configured issuer exactly
 * (mix-up defence) and every endpoint must share the issuer's origin. An unreachable IdP (network,
 * timeout, HTTP 5xx) is a dead dependency (503, DEBT-289); a wrong document stays a 500.
 */
export function createDiscovery(issuer: string, fetchImpl: FetchFn, now: () => number = Date.now) {
  let cached: { value: Discovery; at: number } | undefined;
  return async function discovery(): Promise<Discovery> {
    if (cached && now() - cached.at < TTL_MS) return cached.value;
    const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
    let res: Response;
    try {
      res = await fetchWithTimeout(fetchImpl, url, { headers: { accept: "application/json" } }, 5000);
    } catch (err) {
      throw new ServiceUnavailableError("Discovery unreachable", { cause: err });
    }
    if (res.status >= 500) throw new ServiceUnavailableError(`Discovery failed: HTTP ${res.status}`);
    if (!res.ok) throw new Error(`Discovery failed: HTTP ${res.status}`);
    const doc = DiscoverySchema.parse(await res.json());
    if (doc.issuer !== issuer) throw new Error("Discovery issuer mismatch");
    const origin = new URL(issuer).origin;
    const { issuer: _issuer, ...endpoints } = doc;
    for (const [name, value] of Object.entries(endpoints)) {
      if (new URL(value).origin !== origin) throw new Error(`Discovery ${name} is not on the issuer origin`);
    }
    cached = { value: doc, at: now() };
    return doc;
  };
}
