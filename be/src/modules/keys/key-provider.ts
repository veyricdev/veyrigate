import type { JWTPayload } from 'jose';

/** Public signing key as published in JWKS — never contains private members. */
export interface PublicJwk {
  kty: 'RSA';
  kid: string;
  alg: 'RS256';
  use: 'sig';
  n: string;
  e: string;
}

export type RotationMode = 'normal' | 'emergency';

/** Signing key metadata for the admin API (B6.3c) — never any key material. */
export interface KeyMetadata {
  kid: string;
  alg: 'RS256';
  status: 'active' | 'retiring';
  createdAt: string;
  retireAt: string | null;
}

export interface RotationResult {
  newKid: string;
  oldKid: string | null;
  mode: RotationMode;
}

/**
 * Signing key source (plan D9, spec §6.4). The private key never leaves the provider (Vault Transit
 * in prod, INV-19): callers get a signed token, never key material.
 */
export interface KeyProvider {
  /**
   * Sign a JWT with the active key in ONE call (no "read kid, rotate, sign with another key" race).
   * The provider sets the protected header `{alg: 'RS256', kid, typ}`.
   */
  signJwt(header: { typ: string }, payload: JWTPayload): Promise<string>;
  /**
   * Keys valid for verification: the active key plus retiring keys not yet expired. `kidHint` is
   * the `kid` of the token being verified: a provider whose key set may be stale (another instance
   * rotated) may refresh once when the hint is unknown (rate-limited); others ignore it.
   */
  getPublicKeys(kidHint?: string): Promise<PublicJwk[]>;
  /** Metadata of the same key set as `getPublicKeys()` (read-only, no key material). */
  listKeys(): Promise<KeyMetadata[]>;
  /**
   * normal: new active key; old key stays verify-only for `retainSec` seconds.
   * emergency: new active key; old key is removed immediately.
   */
  rotate(mode: RotationMode, retainSec: number): Promise<RotationResult>;
}

export const KEY_PROVIDER = Symbol('KEY_PROVIDER');
