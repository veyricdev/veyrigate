import { createHmac, timingSafeEqual } from 'node:crypto';

/** RFC 6238 parameters of every authenticator (D89.10): SHA-1, 6 digits, 30 s, ±1 step. */
export const TOTP_PERIOD_SEC = 30;
const DIGITS = 6;
const CODE = /^\d{6}$/;

/** Indirection for the constant-time compare, so a unit test can count the comparisons. */
export const totpInternals = { equal: timingSafeEqual };

/** RFC 4226 HOTP: HMAC-SHA-1 of the 8-byte big-endian counter, dynamic truncation. Pure. */
export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** The time step of `nowMs` (RFC 6238, T0 = 0). */
export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SEC);
}

/** The code of one time step. */
export function totpAt(secret: Buffer, step: number, digits = DIGITS): string {
  return hotp(secret, step, digits);
}

/**
 * Check a typed code (spaces ignored) against steps c-1, c, c+1 of `nowMs`. All three are compared
 * in constant time (no early exit). Returns the largest matching step that is NEWER than
 * `lastStep` (a step is accepted at most once, D89.10), or null.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  nowMs: number,
  lastStep?: number,
): number | null {
  const typed = code.replace(/\s+/g, '');
  if (!CODE.test(typed)) return null;
  const given = Buffer.from(typed, 'ascii');
  const c = totpStep(nowMs);
  let matched: number | null = null;
  for (const step of [c - 1, c, c + 1]) {
    const ok = totpInternals.equal(Buffer.from(totpAt(secret, step), 'ascii'), given);
    if (ok && (lastStep === undefined || step > lastStep)) matched = step;
  }
  return matched;
}
