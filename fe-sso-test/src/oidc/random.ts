import { base64UrlEncode } from "./base64url";

/**
 * Cryptographically random URL-safe token. 32 bytes = 256 bits of entropy, comfortably above
 * the ≥128-bit bar for `state`/`nonce`/PKCE `code_verifier` (spec §9.1/§9.2). Uses
 * WebCrypto `getRandomValues` (browser + Node 22). `crypto` is injectable for tests.
 */
export function randomUrlToken(bytes = 32, cryptoImpl: Crypto = globalThis.crypto): string {
  const buf = new Uint8Array(bytes);
  cryptoImpl.getRandomValues(buf);
  return base64UrlEncode(buf);
}
