import { jwtVerify, createRemoteJWKSet, type JWTVerifyGetKey } from "jose";
import type { IdTokenClaims } from "./types";

/** Clock skew tolerance for `exp`/`iat`/`nbf` (F5): small, fail-closed. */
export const CLOCK_TOLERANCE_SEC = 5;

export interface IdTokenPolicy {
  readonly issuer: string;
  readonly audience: string;
  /** JWKS key resolver. Normally `createJwks(jwksUri)`; injectable for tests. */
  readonly jwks: JWTVerifyGetKey;
}

/**
 * Build a JWKS resolver bound to the IdP's `jwks_uri`. jose fetches + caches signing keys and
 * rotates on unknown `kid`. Fails closed if the key set cannot be fetched.
 */
export function createJwks(jwksUri: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(jwksUri));
}

/**
 * Validate an ID token (OIDC Core §3.1.3.7, INV-6/-7).
 *
 * Always enforced (fail-closed): signature over JWKS, `alg === RS256` (no `none`/HS downgrade),
 * `iss === policy.issuer`, `aud` contains `policy.audience`, `exp`/`iat` within tolerance.
 *
 * `nonce` handling:
 *  - callback mode (`expectedNonce` set): token `nonce` MUST equal it (replay/CSRF defence).
 *  - refresh mode (`expectedNonce` undefined, `previousSub` set, F4): the refreshed ID token
 *    MUST carry no `nonce` (BE omits it); a stray `nonce` is rejected. We also require
 *    `sub === previousSub` so the refresh cannot swap identities.
 */
export async function validateIdToken(
  idToken: string,
  policy: IdTokenPolicy,
  opts: { expectedNonce?: string; previousSub?: string },
): Promise<IdTokenClaims> {
  // `algorithms: ["RS256"]` is the single source of truth for the signing algorithm: jose
  // rejects `none`/HS*/PS* before returning (locked by test/idToken.test.ts), so no `none`/HS
  // downgrade is possible and we need no redundant header check here.
  const { payload } = await jwtVerify(idToken, policy.jwks, {
    issuer: policy.issuer,
    audience: policy.audience,
    algorithms: ["RS256"],
    clockTolerance: CLOCK_TOLERANCE_SEC,
    requiredClaims: ["iss", "sub", "aud", "exp", "iat"],
  });

  const claims = payload as unknown as IdTokenClaims;

  // §3.1.3.7 rule 4: when `aud` has multiple values, `azp` MUST be present and === our client_id.
  if (Array.isArray(claims.aud) && claims.aud.length > 1) {
    if (claims.azp !== policy.audience) {
      throw new Error("ID token rejected: azp missing or not the client when aud is multi-valued");
    }
  }

  if (opts.expectedNonce !== undefined) {
    // Callback mode: nonce must be present and match.
    if (claims.nonce !== opts.expectedNonce) {
      throw new Error("ID token rejected: nonce mismatch");
    }
  } else {
    // Refresh mode (F4): refreshed ID token carries no nonce.
    if (claims.nonce !== undefined) {
      throw new Error("ID token rejected: unexpected nonce on refreshed token");
    }
    if (opts.previousSub !== undefined && claims.sub !== opts.previousSub) {
      throw new Error("ID token rejected: sub changed across refresh");
    }
  }

  return claims;
}
