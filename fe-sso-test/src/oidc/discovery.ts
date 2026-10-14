import { z } from "zod";
import { fetchWithTimeout, type FetchFn } from "./http";

/**
 * Subset of OIDC discovery metadata (spec §12) this client relies on. Required endpoints are
 * non-empty URLs; `userinfo_endpoint` is optional (not needed for the core flow).
 */
const DiscoverySchema = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
  end_session_endpoint: z.string().url(),
  userinfo_endpoint: z.string().url().optional(),
});

export type Discovery = z.infer<typeof DiscoverySchema>;

/**
 * Fetch and validate `{issuer}/.well-known/openid-configuration`.
 *
 * Security (F5, mix-up defence / INV-9): the document's `issuer` MUST equal the configured
 * `expectedIssuer` exactly; a mismatch throws and NO endpoint is trusted. Required endpoints
 * must all be present or discovery fails closed. Network call is time-boxed (F6).
 */
export async function discover(
  expectedIssuer: string,
  fetchImpl: FetchFn = fetch,
): Promise<Discovery> {
  const url = `${expectedIssuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const res = await fetchWithTimeout(fetchImpl, url, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Discovery failed: HTTP ${res.status} from ${url}`);
  }

  const parsed = DiscoverySchema.safeParse(await res.json());
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Discovery document is missing/invalid required fields: ${missing}`);
  }

  if (parsed.data.issuer !== expectedIssuer) {
    throw new Error(
      `Discovery issuer mismatch: expected "${expectedIssuer}", got "${parsed.data.issuer}" (possible mix-up attack)`,
    );
  }

  return parsed.data;
}
