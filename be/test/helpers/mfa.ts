import type { Provider } from '@nestjs/common';
import type { Connection } from 'mongoose';
import { Types } from 'mongoose';
import { MFA_KEYRING, MfaKeyring, parseMfaKeys, totpAad } from '../../src/modules/mfa/mfa-crypto';
import { MfaLoginService } from '../../src/modules/mfa/mfa-login.service';
import { MfaService } from '../../src/modules/mfa/mfa.service';
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  newRecoverySalt,
  normalizeRecoveryCode,
} from '../../src/modules/mfa/recovery-codes';

/**
 * `MFA_ENCRYPTION_KEYS` of every int/CLI test env (run 89, D89.4): a fixed, public, non-secret key
 * (not the `.env.example` one). Test-only: never under `src/`, never in `dist`.
 */
export const TEST_MFA_ENCRYPTION_KEYS = 'k1:dmV5cmlnYXRlLWludC1tZmEta2V5LW5vdC1zZWNyZXQ=';

export const testKeyring = (raw = TEST_MFA_ENCRYPTION_KEYS): MfaKeyring =>
  new MfaKeyring(parseMfaKeys(raw));

/**
 * Write `User.mfa` directly (run 89 T1 AC11) for specs and seeds that need an enrolled user
 * without going through `/account/mfa`. Same document shape as `MfaService.enroll`.
 */
export async function enrollForTest(
  conn: Connection,
  keyring: MfaKeyring,
  userId: string,
  secret: Buffer,
  opts: { enrolledAt?: Date; lastStep?: number; codes?: string[] } = {},
): Promise<{ enrolledAt: Date; codes: string[] }> {
  const enrolledAt = opts.enrolledAt ?? new Date();
  const codes = opts.codes ?? generateRecoveryCodes();
  const recoverySalt = newRecoverySalt();
  const mfa: Record<string, unknown> = {
    secret: keyring.seal(secret, totpAad(userId)),
    enrolledAt,
    recoverySalt,
    recovery: codes.map((c) => ({
      hash: hashRecoveryCode(recoverySalt, normalizeRecoveryCode(c)!),
    })),
    ...(opts.lastStep !== undefined ? { lastStep: opts.lastStep } : {}),
  };
  const r = await conn
    .collection('users')
    .updateOne({ _id: new Types.ObjectId(userId) }, { $set: { mfa } });
  if (r.matchedCount !== 1) throw new Error('enrollForTest: no such user');
  return { enrolledAt, codes };
}

/**
 * Providers a hand-composed test module needs once it includes `UiController` / `FederationService`
 * (run 89: both start MFA tickets). Real services on the test keyring; Mongo models, Redis, config,
 * sessions, users, audit, throttle and rate limit come from the module itself.
 */
export const mfaTestProviders = (): Provider[] => [
  MfaLoginService,
  MfaService,
  { provide: MFA_KEYRING, useValue: testKeyring() },
];
