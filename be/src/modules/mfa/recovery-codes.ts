import { createHash, randomBytes } from 'node:crypto';

/** Crockford base32 (no I, L, O, U): readable, and typos fold back (D89.11). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const RECOVERY_CODE_COUNT = 10;

/** 16 characters from 10 CSPRNG bytes (80 bit). */
function newCode(): string {
  const bytes = randomBytes(10);
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  let out = '';
  for (let i = 15; i >= 0; i--) out += CROCKFORD[Number((value >> BigInt(i * 5)) & 31n)];
  return out;
}

/** `count` distinct codes, displayed `XXXX-XXXX-XXXX-XXXX`. Shown once, never stored in clear. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(newCode());
  return [...codes].map((c) => c.match(/.{4}/g)!.join('-'));
}

/** Upper-case, drop dashes/spaces, O->0, I/L->1; null unless 16 alphabet characters remain. */
export function normalizeRecoveryCode(input: string): string | null {
  const code = input
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (code.length !== 16) return null;
  for (const ch of code) if (!CROCKFORD.includes(ch)) return null;
  return code;
}

/** 16-byte per-user salt, hex. */
export function newRecoverySalt(): string {
  return randomBytes(16).toString('hex');
}

/** Stored form of a normalized code: sha256(salt || code), hex (80-bit codes: no slow hash needed). */
export function hashRecoveryCode(salt: string, normalized: string): string {
  return createHash('sha256').update(salt, 'utf8').update(normalized, 'utf8').digest('hex');
}
