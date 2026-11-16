import { Schema } from 'mongoose';

/**
 * Second factor (run 89, D89.3): the TOTP seed sealed with `MFA_ENCRYPTION_KEYS` (AAD bound to the
 * user), the last accepted step (replay CAS) and salted hashes of the recovery codes. `select:false`:
 * only `MfaService` reads it whole; others project `mfa.enrolledAt`.
 */
const MfaSchema = new Schema(
  {
    secret: {
      kid: { type: String, required: true },
      iv: { type: String, required: true },
      ct: { type: String, required: true },
      tag: { type: String, required: true },
    },
    enrolledAt: { type: Date, required: true },
    lastStep: { type: Number },
    // DEBT-640 (D89.25): consecutive wrong codes (any path); absent = 0, unset by any right code.
    failures: { type: Number },
    recoverySalt: { type: String, required: true },
    recovery: { type: [new Schema({ hash: { type: String, required: true } }, { _id: false })] },
  },
  { _id: false },
);

/** User (spec §10). `passwordHash` = argon2id PHC string, never plaintext. */
export const UserSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, select: false },
    profile: { type: Schema.Types.Mixed, default: {} },
    mfa: { type: MfaSchema, select: false },
    emailVerifiedAt: { type: Date },
    lockedUntil: { type: Date },
    // Level of an admin lock (DEBT-153); absent with the admin sentinel => super_admin.
    adminLockLevel: { type: String, enum: ['tenant_admin', 'super_admin'] },
    // Per-user strictly increasing mark of admin lock/unlock writes = their audit timestamp (run 57).
    adminLockMarkAt: { type: Date },
  },
  { timestamps: true },
);
UserSchema.index({ email: 1 }, { unique: true });
