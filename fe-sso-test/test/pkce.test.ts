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

// RFC 7636 Appendix B: the 32 random octets, the resulting verifier and its S256 challenge.
const RFC7636_OCTETS = [
  116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77,
  105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
];
const RFC7636_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC7636_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

/** WebCrypto whose RNG yields the RFC octets; `subtle` stays the real one. */
function rfcCrypto(): Crypto {
  return {
    getRandomValues: <T extends ArrayBufferView | null>(buf: T): T => {
      (buf as unknown as Uint8Array).set(RFC7636_OCTETS);
      return buf;
    },
    subtle: crypto.subtle,
  } as unknown as Crypto;
}

describe("createPkce (RFC 7636 Appendix B vector)", () => {
  it("derives the RFC verifier and S256 challenge from the RFC octets", async () => {
    const pkce = await createPkce(rfcCrypto());
    expect(pkce.verifier).toBe(RFC7636_VERIFIER);
    expect(pkce.challenge).toBe(RFC7636_CHALLENGE);
    expect(pkce.method).toBe("S256");
  });

  it("verifier is 43-128 chars of the RFC 7636 unreserved set only", async () => {
    for (let i = 0; i < 20; i++) {
      const { verifier } = await createPkce();
      expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    }
  });
});

describe("base64UrlEncode (RFC 4648 §5, unpadded)", () => {
  const decode = (s: string) => Uint8Array.from(Buffer.from(s, "base64url"));

  it("maps 0xfb/0xff to '-'/'_' (never '+'/'/') and drops '='", () => {
    // Standard base64 of [0xfb, 0xff] is "+/8=".
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xef, 0xff]))).toBe("--__");
  });

  it("never emits '=', '+' or '/' for any length, and round-trips the bytes", () => {
    for (let len = 0; len <= 8; len++) {
      const bytes = new Uint8Array(len).map((_, i) => (i % 2 ? 0xff : 0xfb));
      const enc = base64UrlEncode(bytes);
      expect(enc).not.toMatch(/[=+/]/);
      expect(Array.from(decode(enc))).toEqual(Array.from(bytes));
    }
  });
});
