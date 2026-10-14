import { base64UrlEncode } from "./base64url";
import { randomUrlToken } from "./random";

export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: "S256";
}

/**
 * Create a PKCE pair (RFC 7636). The `code_verifier` is a 43–128 char high-entropy string;
 * the `code_challenge` is base64url(SHA-256(verifier)) and the method is ALWAYS `S256`
 * (never `plain` — downgrade protection, INV-3). WebCrypto `subtle.digest` is injectable.
 */
export async function createPkce(cryptoImpl: Crypto = globalThis.crypto): Promise<Pkce> {
  const verifier = randomUrlToken(32, cryptoImpl);
  const data = new TextEncoder().encode(verifier);
  const digest = await cryptoImpl.subtle.digest("SHA-256", data);
  const challenge = base64UrlEncode(new Uint8Array(digest));
  return { verifier, challenge, method: "S256" };
}
