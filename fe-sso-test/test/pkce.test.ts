// @vitest-environment node
import { describe, it, expect } from "vitest";
import { createPkce } from "../src/oidc/pkce";
import { base64UrlEncode } from "../src/oidc/base64url";

describe("createPkce (S256)", () => {
  it("method is always S256, never plain", async () => {
    const pkce = await createPkce();
    expect(pkce.method).toBe("S256");
  });

  it("challenge equals base64url(SHA-256(verifier)) with no padding", async () => {
    const pkce = await createPkce();
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(pkce.verifier),
    );
    const expected = base64UrlEncode(new Uint8Array(digest));
    expect(pkce.challenge).toBe(expected);
    expect(pkce.challenge).not.toMatch(/[=+/]/); // url-safe, unpadded
  });

  it("verifier has >=128 bits entropy and differs each call", async () => {
    const a = await createPkce();
    const b = await createPkce();
    expect(a.verifier).not.toBe(b.verifier);
    // 32 bytes base64url -> 43 chars; well above the 43-char / 128-bit minimum.
    expect(a.verifier.length).toBeGreaterThanOrEqual(43);
  });
});
