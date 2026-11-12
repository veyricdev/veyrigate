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

/**
 * Derived from time, never stored (run 86, DEBT-393, D86.11): `pending` = in JWKS, does not sign
 * before `activatesAt`; `active` = signs; `retiring` = verify-only until `retireAt`.
 */
export type KeyStatus = 'pending' | 'active' | 'retiring';

/** Signing key metadata for the admin API (B6.3c) — never any key material. */
export interface KeyMetadata {
  kid: string;
  alg: 'RS256';
  status: KeyStatus;
  createdAt: string;
  /** When the key signs (or signed) from; `createdAt` for the first key and after an emergency. */
  activatesAt: string;
  /** `null` for pending and active keys. */
  retireAt: string | null;
}

export interface RotationResult {
  newKid: string;
  oldKid: string | null;
  mode: RotationMode;
  /** When `newKid` starts signing (= its creation for an emergency rotation). */
  activatesAt: string;
}

/**
 * A normal rotation while a newer key is still pending (D85.7/D86.8): refused, nothing changes.
 * The Admin API answers a fixed 409 `conflict`; the audit records `rotation_pending`.
 */
export class RotationPendingError extends Error {
  constructor(
    readonly pendingKid: string,
    readonly activatesAt: string,
  ) {
    super('A newer signing key is already published and does not sign yet.');
    this.name = 'RotationPendingError';
  }
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
   * normal: new key published at once, signs from now + the provider's pre-publish delay; the old key
   * keeps signing until then and stays verify-only for `retainSec` seconds after it. Refused with
   * `RotationPendingError` while a key is pending.
   * emergency: new key signs at once; every other key (pending included) is removed immediately.
   */
  rotate(mode: RotationMode, retainSec: number): Promise<RotationResult>;
}

export const KEY_PROVIDER = Symbol('KEY_PROVIDER');
