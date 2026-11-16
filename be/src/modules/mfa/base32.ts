import { randomBytes } from 'node:crypto';

/** RFC 4648 base32 alphabet (authenticator apps expect it, without padding). */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Strict decode: any character outside the alphabet (padding, lowercase, space) throws. */
export function base32Decode(text: string): Buffer {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of text) {
    const index = ALPHABET.indexOf(ch);
    if (index === -1) throw new Error('invalid base32 character');
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new TOTP seed: 20 CSPRNG bytes (160 bit, RFC 4226 recommendation) = 32 base32 characters. */
export function newTotpSecret(): Buffer {
  return randomBytes(20);
}
