import "@tanstack/react-start/server-only";
import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

/** Clock skew tolerance for exp/iat (ported from fe-sso-test `oidc/idToken.ts`). */
const CLOCK_TOLERANCE_SEC = 5;

export interface IdTokenPolicy {
  issuer: string;
  clientId: string;
  jwks: JWTVerifyGetKey;
}

export type IdTokenClaims = JWTPayload & { sub: string; nonce?: unknown; auth_time?: unknown };

/**
 * Validates an ID token at the RP (INV-6): RS256 only (no `none`/HS*), signature over the IdP JWKS,
 * `iss`, `aud` contains the client (and `azp` when multi-valued), `exp`/`iat`, string `sub`.
 * Callback mode (`nonce` given): the claim must equal it. Refresh mode (`sub` given): the IdP omits
 * nonce/auth_time on refreshed tokens, so neither is required, but `sub` must not change.
 */
export async function verifyIdToken(
  idToken: string,
  policy: IdTokenPolicy,
  expect: { nonce: string } | { sub: string },
): Promise<IdTokenClaims> {
  const { payload } = await jwtVerify(idToken, policy.jwks, {
    issuer: policy.issuer,
    audience: policy.clientId,
    algorithms: ["RS256"],
    clockTolerance: CLOCK_TOLERANCE_SEC,
    requiredClaims: ["iss", "sub", "aud", "exp", "iat"],
  });
  if (typeof payload.sub !== "string" || payload.sub.length === 0) throw new Error("ID token sub invalid");
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== policy.clientId) {
    throw new Error("ID token azp invalid");
  }
  if ("nonce" in expect && payload.nonce !== expect.nonce) throw new Error("ID token nonce mismatch");
  if ("sub" in expect && payload.sub !== expect.sub) throw new Error("ID token sub changed");
  return payload as IdTokenClaims;
}
