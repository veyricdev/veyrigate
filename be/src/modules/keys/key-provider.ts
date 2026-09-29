import type { KeyObject } from 'node:crypto';

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

export interface RotationResult {
  newKid: string;
  oldKid: string | null;
  mode: RotationMode;
}

/**
 * Signing key source (plan D9, spec §6.4). Implementations keep the private key
 * inside the provider (KMS/Vault in prod) and only hand out a signing handle.
 */
export interface KeyProvider {
  /** Active key used to sign new tokens. */
  getSigningKey(): Promise<{ kid: string; privateKey: KeyObject }>;
  /** Keys valid for verification: the active key plus retiring keys not yet expired. */
  getPublicKeys(): Promise<PublicJwk[]>;
  /**
   * normal: new active key; old key stays verify-only for `retainSec` seconds.
   * emergency: new active key; old key is removed immediately.
   */
  rotate(mode: RotationMode, retainSec: number): Promise<RotationResult>;
}

export const KEY_PROVIDER = Symbol('KEY_PROVIDER');
