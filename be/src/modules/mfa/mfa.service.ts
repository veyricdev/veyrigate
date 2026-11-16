import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, type Model, type Types } from 'mongoose';
import { MFA_KEYRING, MfaKeyring, totpAad, type SealedSecret } from './mfa-crypto';
import { hashRecoveryCode, newRecoverySalt, normalizeRecoveryCode } from './recovery-codes';
import { verifyTotp } from './totp';

interface MfaDoc {
  secret: SealedSecret;
  enrolledAt: Date;
  lastStep?: number;
  recoverySalt: string;
  recovery: { hash: string }[];
  failures?: number;
}
interface UserMfaDoc {
  _id: Types.ObjectId;
  mfa?: MfaDoc;
}

export type MfaState =
  | { enrolled: false }
  | { enrolled: true; enrolledAt: Date; recoveryLeft: number };

/** A factor check: `enrolledAt` is the enrollment it was checked against (re-checked later). */
export type MfaCheck =
  | { ok: true; enrolledAt: Date; step?: number; recoveryLeft?: number }
  | { ok: false; suspended?: true };

const FAIL: MfaCheck = { ok: false };

/**
 * DEBT-640 (D89.25): consecutive wrong second-factor codes per user (every path, ticket and window)
 * after which authenticator codes are refused, right or wrong (NIST 800-63B 5.2.2: at most 100). A
 * recovery code or an MFA reset (admin/CLI) ends it; a password reset does not (D89.28). Any right
 * code resets the count.
 */
export const MFA_FAILURE_CAP = 50;

/**
 * The second factor's state in Mongo (run 89, D89.2/D89.3, no Redis). Every write is a
 * compare-and-set on `mfa.enrolledAt` (a reset or re-enrollment in between makes it miss); TOTP
 * replay protection is the CAS on `mfa.lastStep`, so a step is accepted at most once across
 * instances. Mongo errors propagate (never "right code"); a seed that cannot be decrypted counts as
 * a wrong code (logged by the keyring with `kid` only).
 */
@Injectable()
export class MfaService {
  constructor(
    @InjectModel('User') private readonly users: Model<UserMfaDoc>,
    @Inject(MFA_KEYRING) private readonly keyring: MfaKeyring,
  ) {}

  clock(): number {
    return Date.now();
  }

  async state(userId: string): Promise<MfaState> {
    const mfa = await this.read(userId);
    return mfa
      ? { enrolled: true, enrolledAt: mfa.enrolledAt, recoveryLeft: mfa.recovery.length }
      : { enrolled: false };
  }

  /**
   * First enrollment: CAS on "no `mfa` yet" (two tabs => one wins). `lastStep` = the step of the
   * confirming code, so that code can never sign in (replay). Returns the stored `enrolledAt`.
   */
  async enroll(
    userId: string,
    secret: Buffer,
    step: number,
    codes: string[],
  ): Promise<{ ok: true; enrolledAt: Date } | { ok: false }> {
    if (!isValidObjectId(userId)) return { ok: false };
    const enrolledAt = new Date(this.clock());
    const recoverySalt = newRecoverySalt();
    const mfa: MfaDoc = {
      secret: this.keyring.seal(secret, totpAad(userId)),
      enrolledAt,
      lastStep: step,
      recoverySalt,
      recovery: this.hashes(recoverySalt, codes),
    };
    const r = await this.users.updateOne(
      { _id: userId, mfa: { $exists: false } },
      { $set: { mfa } },
    );
    return r.modifiedCount === 1 ? { ok: true, enrolledAt } : { ok: false };
  }

  /**
   * TOTP check + replay CAS. With `enrolledAt`, only that enrollment counts. A seed sealed under an
   * older kid is re-sealed with the current one in the SAME update (lazy rotation, D89.12).
   */
  async verify(
    userId: string,
    code: string,
    enrolledAt?: Date,
    requestId?: string,
  ): Promise<MfaCheck> {
    const mfa = await this.read(userId);
    if (!mfa || (enrolledAt && mfa.enrolledAt.getTime() !== enrolledAt.getTime())) return FAIL;
    if ((mfa.failures ?? 0) >= MFA_FAILURE_CAP) return { ok: false, suspended: true };
    const secret = this.keyring.open(mfa.secret, totpAad(userId), requestId);
    if (!secret) return FAIL;
    const step = verifyTotp(secret, code, this.clock(), mfa.lastStep);
    if (step === null) return FAIL;
    const set: Record<string, unknown> = { 'mfa.lastStep': step };
    if (mfa.secret.kid !== this.keyring.currentKid) {
      set['mfa.secret'] = this.keyring.seal(secret, totpAad(userId));
    }
    const r = await this.users.updateOne(
      {
        _id: userId,
        'mfa.enrolledAt': mfa.enrolledAt,
        // D89.25: the cap is part of the CAS too (a concurrent failure reaching it wins).
        'mfa.failures': { $not: { $gte: MFA_FAILURE_CAP } },
        $or: [{ 'mfa.lastStep': { $lt: step } }, { 'mfa.lastStep': { $exists: false } }],
      },
      { $set: set, $unset: { 'mfa.failures': 1 } },
    );
    return r.modifiedCount === 1 ? { ok: true, enrolledAt: mfa.enrolledAt, step } : FAIL;
  }

  /** One recovery code, at most once: `$pull` of its hash is the CAS. */
  async consumeRecovery(userId: string, code: string, enrolledAt?: Date): Promise<MfaCheck> {
    const normalized = normalizeRecoveryCode(code);
    if (!normalized) return FAIL;
    const mfa = await this.read(userId);
    if (!mfa || (enrolledAt && mfa.enrolledAt.getTime() !== enrolledAt.getTime())) return FAIL;
    const hash = hashRecoveryCode(mfa.recoverySalt, normalized);
    const after = await this.users
      .findOneAndUpdate(
        { _id: userId, 'mfa.enrolledAt': mfa.enrolledAt, 'mfa.recovery.hash': hash },
        { $pull: { 'mfa.recovery': { hash } }, $unset: { 'mfa.failures': 1 } },
        { returnDocument: 'after' },
      )
      .select('+mfa')
      .lean<UserMfaDoc>()
      .exec();
    if (!after) return FAIL;
    return { ok: true, enrolledAt: mfa.enrolledAt, recoveryLeft: after.mfa?.recovery.length ?? 0 };
  }

  /**
   * One more consecutive wrong code (DEBT-640). Returns the new count, or null when the user has no
   * factor any more. Mongo errors propagate.
   */
  async recordFailure(userId: string): Promise<number | null> {
    if (!isValidObjectId(userId)) return null;
    const after = await this.users
      .findOneAndUpdate(
        { _id: userId, mfa: { $exists: true } },
        { $inc: { 'mfa.failures': 1 } },
        { returnDocument: 'after' },
      )
      .select('+mfa')
      .lean<UserMfaDoc>()
      .exec();
    return after?.mfa?.failures ?? null;
  }

  /** New salt + codes for the same enrollment (every old code dies). */
  async regenerate(userId: string, enrolledAt: Date, codes: string[]): Promise<boolean> {
    if (!isValidObjectId(userId)) return false;
    const recoverySalt = newRecoverySalt();
    const r = await this.users.updateOne(
      { _id: userId, 'mfa.enrolledAt': enrolledAt },
      {
        $set: {
          'mfa.recoverySalt': recoverySalt,
          'mfa.recovery': this.hashes(recoverySalt, codes),
        },
      },
    );
    return r.modifiedCount === 1;
  }

  /** Remove the factor of THIS enrollment (a re-enrollment in between makes it miss). */
  async disable(userId: string, enrolledAt: Date): Promise<boolean> {
    if (!isValidObjectId(userId)) return false;
    const r = await this.users.updateOne(
      { _id: userId, 'mfa.enrolledAt': enrolledAt },
      { $unset: { mfa: 1 } },
    );
    return r.modifiedCount === 1;
  }

  private hashes(salt: string, codes: string[]): { hash: string }[] {
    return codes.map((c) => ({ hash: hashRecoveryCode(salt, normalizeRecoveryCode(c)!) }));
  }

  private async read(userId: string): Promise<MfaDoc | null> {
    if (!isValidObjectId(userId)) return null;
    const doc = await this.users.findById(userId).select('+mfa').lean<UserMfaDoc>().exec();
    return doc?.mfa ?? null;
  }
}
