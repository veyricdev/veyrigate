// @vitest-environment node
import { describe, it, expect, beforeAll } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { validateIdToken, type IdTokenPolicy } from "../src/oidc/idToken";
import {
  makeKeys,
  signHs256IdToken,
  signIdToken,
  unsecuredIdToken,
  type TestKeys,
} from "./helpers/jwt";

const ISSUER = "http://localhost:4000";
const AUD = "fe-sso-test";
const NONCE = "nonce-abc";

let keys: TestKeys;
let policy: IdTokenPolicy;

beforeAll(async () => {
  keys = await makeKeys();
  policy = {
    issuer: ISSUER,
    audience: AUD,
    jwks: createLocalJWKSet({ keys: [keys.publicJwk] }),
  };
});

describe("validateIdToken (callback mode)", () => {
  it("accepts a valid token", async () => {
    const token = await signIdToken(keys, { nonce: NONCE });
    const claims = await validateIdToken(token, policy, { expectedNonce: NONCE });
    expect(claims.sub).toBe("user-123");
  });

  it("rejects a nonce mismatch", async () => {
    const token = await signIdToken(keys, { nonce: "other" });
    await expect(validateIdToken(token, policy, { expectedNonce: NONCE })).rejects.toThrow();
  });

  it("rejects a wrong audience", async () => {
    const token = await signIdToken(keys, { nonce: NONCE, audience: "someone-else" });
    await expect(validateIdToken(token, policy, { expectedNonce: NONCE })).rejects.toThrow();
  });

  it("rejects a wrong issuer", async () => {
    const token = await signIdToken(keys, { nonce: NONCE, issuer: "http://evil.example" });
    await expect(validateIdToken(token, policy, { expectedNonce: NONCE })).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const token = await signIdToken(keys, { nonce: NONCE, expiresIn: "-1h" });
    await expect(validateIdToken(token, policy, { expectedNonce: NONCE })).rejects.toThrow();
  });

  it("rejects a token signed by an unknown key (bad signature)", async () => {
    const otherKeys = await makeKeys("other-key");
    const token = await signIdToken(otherKeys, { nonce: NONCE });
    await expect(validateIdToken(token, policy, { expectedNonce: NONCE })).rejects.toThrow();
  });
});

describe("validateIdToken (algorithm pinning, F5)", () => {
  // JWKS WITHOUT the `alg` restriction so jose's key selection does not pre-filter by algorithm;
  // this forces the RS256 pin itself (not key-matching) to be the thing that rejects.
  function unrestrictedPolicy(): IdTokenPolicy {
    const jwk = { ...keys.publicJwk };
    delete jwk.alg;
    return { issuer: ISSUER, audience: AUD, jwks: createLocalJWKSet({ keys: [jwk] }) };
  }

  it("rejects PS256 (RSA-PSS) even with a matching key — RS256 is pinned", async () => {
    // Use a real PS256 (RSA-PSS) key and publish it in the JWKS so key-matching succeeds; only the
    // RS256 algorithm pin can be what rejects the token.
    const { privateKey, publicKey } = await generateKeyPair("PS256", { extractable: true });
    const jwk = await exportJWK(publicKey);
    jwk.kid = "ps256-key";
    const token = await new SignJWT({ nonce: NONCE })
      .setProtectedHeader({ alg: "PS256", kid: "ps256-key" })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setSubject("user-123")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    const policyPs: IdTokenPolicy = {
      issuer: ISSUER,
      audience: AUD,
      jwks: createLocalJWKSet({ keys: [jwk] }),
    };
    await expect(validateIdToken(token, policyPs, { expectedNonce: NONCE })).rejects.toThrow();
  });

  it("rejects HS256 (symmetric downgrade)", async () => {
    const secret = new Uint8Array(32).fill(7);
    const token = await signHs256IdToken(secret, { nonce: NONCE });
    await expect(
      validateIdToken(token, unrestrictedPolicy(), { expectedNonce: NONCE }),
    ).rejects.toThrow();
  });

  it("rejects an unsecured token (alg: none)", async () => {
    const token = unsecuredIdToken({ nonce: NONCE });
    await expect(
      validateIdToken(token, unrestrictedPolicy(), { expectedNonce: NONCE }),
    ).rejects.toThrow();
  });
});

describe("validateIdToken (azp when aud is multi-valued, OIDC Core 3.1.3.7)", () => {
  it("rejects a multi-valued aud without a matching azp", async () => {
    const token = await signIdToken(keys, { nonce: NONCE, aud: [AUD, "other-rp"] });
    await expect(validateIdToken(token, policy, { expectedNonce: NONCE })).rejects.toThrow(/azp/);
  });

  it("accepts a multi-valued aud when azp === client_id", async () => {
    const token = await signIdToken(keys, { nonce: NONCE, aud: [AUD, "other-rp"], azp: AUD });
    const claims = await validateIdToken(token, policy, { expectedNonce: NONCE });
    expect(claims.sub).toBe("user-123");
  });
});

describe("validateIdToken (refresh mode, F4)", () => {
  it("accepts a token with no nonce and the same sub", async () => {
    const token = await signIdToken(keys, { omitNonce: true, sub: "user-123" });
    const claims = await validateIdToken(token, policy, { previousSub: "user-123" });
    expect(claims.sub).toBe("user-123");
  });

  it("rejects a token whose sub changed across refresh", async () => {
    const token = await signIdToken(keys, { omitNonce: true, sub: "attacker" });
    await expect(validateIdToken(token, policy, { previousSub: "user-123" })).rejects.toThrow(
      /sub changed/,
    );
  });

  it("rejects a refreshed token that unexpectedly carries a nonce", async () => {
    const token = await signIdToken(keys, { nonce: "surprise", sub: "user-123" });
    await expect(validateIdToken(token, policy, { previousSub: "user-123" })).rejects.toThrow(
      /unexpected nonce/,
    );
  });
});
