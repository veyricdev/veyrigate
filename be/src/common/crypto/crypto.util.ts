import { hash as argon2Hash, verify as argon2Verify, Algorithm } from '@node-rs/argon2';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Crypto primitives (B1.5).
 *
 * - Password hashing/verification with Argon2id (`@node-rs/argon2`).
 * - CSPRNG token generation (`crypto.randomBytes` — never `Math.random`).
 * - SHA-256 token hashing (for storing token references, not passwords).
 * - Constant-time comparison (`crypto.timingSafeEqual`).
 */

/** Argon2id parameters (OWASP-recommended baseline). */
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

/** Hash a password with Argon2id. Returns the encoded PHC string. */
export function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, ARGON2_OPTIONS);
}

/** Verify a password against an Argon2 PHC hash. */
export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2Verify(hash, password);
}

/**
 * Generate a URL-safe random token using a CSPRNG.
 * @param byteLength number of random bytes (default 32 → 256 bits of entropy)
 */
export function generateToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

/** SHA-256 hash of a token, hex-encoded (for at-rest token references). */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Constant-time string comparison. Returns false for differing lengths without
 * leaking timing beyond the length check.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
