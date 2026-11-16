import { test, expect } from "@playwright/test";
import { base32Decode, hotp, nextCode, stepAt, totpAt } from "./support/totp";

/**
 * Run 89 T6 AC1: the E2E TOTP helper (`node:crypto` only) against the RFC vectors, no browser.
 * Key = ASCII "12345678901234567890" (RFC 4226 App. D, RFC 6238 App. B SHA-1).
 */
const KEY = Buffer.from("12345678901234567890", "ascii");

test("RFC 4226 App. D: HOTP 6 digits, counter 0-9", () => {
  const want = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  want.forEach((code, counter) => expect(hotp(KEY, counter), `counter ${counter}`).toBe(code));
});

test("RFC 6238 App. B: TOTP SHA-1 8 digits, every vector", () => {
  const vectors: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  for (const [t, code] of vectors) expect(hotp(KEY, stepAt(t * 1000), 8), `T=${t}`).toBe(code);
});

test("base32 round-trip of the RFC key and 6-digit codes from a base32 secret", () => {
  // RFC 4648 base32 of "12345678901234567890".
  expect(base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").equals(KEY)).toBe(true);
  expect(totpAt("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1)).toBe("287082");
  expect(() => base32Decode("not!base32")).toThrow();
});

test("step allocator: a burst gets c-1, c, c+1, never the same step twice (AC2)", async () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const t = 1_000 * 30 * 1_000_000 + 2_000; // 2 s into step 1 000 000
  const now = () => t;
  const codes = [await nextCode(secret, now), await nextCode(secret, now), await nextCode(secret, now)];
  expect(codes).toEqual([totpAt(secret, 999_999), totpAt(secret, 1_000_000), totpAt(secret, 1_000_001)]);
  // Late in a step (< 5 s left) c-1 is skipped: the IdP could already be in step c+1.
  const other = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
  expect(await nextCode(other, () => t + 26_000)).toBe(totpAt(other, 1_000_000));
});
