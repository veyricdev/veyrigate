/** Protected header every IdP token carries (header member order is part of the golden test). */
export interface JwsHeader {
  alg: 'RS256';
  kid: string;
  typ: string;
}

/**
 * Compact JWS (RFC 7515 §7.1) with an external signer (run 53): the private key never enters this
 * process for Vault, so the provider only hands over a `signFn` over the signing input. Only RS256
 * is produced; anything else is refused before `signFn` runs.
 */
export async function encodeCompactJws(
  header: JwsHeader,
  payload: object,
  signFn: (input: Buffer) => Promise<Buffer>,
): Promise<string> {
  if (header.alg !== 'RS256') {
    throw new Error('Only RS256 is supported');
  }
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = await signFn(Buffer.from(input, 'ascii'));
  return `${input}.${signature.toString('base64url')}`;
}

function b64url(json: string): string {
  return Buffer.from(json, 'utf8').toString('base64url');
}
