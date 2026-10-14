/**
 * base64url (RFC 4648 §5) without padding — the encoding OAuth/OIDC use for PKCE
 * challenges, `state`, `nonce`, and JWS segments. Pure, no DOM/Node specifics.
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  // btoa exists in browsers and in Node 22 globalThis.
  const b64 = btoa(binary);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
