import { createHash } from 'node:crypto';

/**
 * PKCE S256 helper (RFC 7636 §4.2) — B1.5.
 *
 * challenge = BASE64URL(SHA256(ASCII(code_verifier)))
 *
 * base64url has no padding and uses `-`/`_` instead of `+`/`/`.
 */
export function deriveS256Challenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
}
