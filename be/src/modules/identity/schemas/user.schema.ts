import { Schema } from 'mongoose';

/** User (spec §10). `passwordHash` = argon2id PHC string, never plaintext. */
export const UserSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, select: false },
    profile: { type: Schema.Types.Mixed, default: {} },
    mfaSecret: { type: String }, // placeholder, not enabled (spec §10)
    emailVerifiedAt: { type: Date },
    failedLoginCount: { type: Number, default: 0 },
    lockedUntil: { type: Date },
    // Level of an admin lock (DEBT-153); absent with the admin sentinel => super_admin.
    adminLockLevel: { type: String, enum: ['tenant_admin', 'super_admin'] },
    lockTransitionNonce: { type: String, select: false },
  },
  { timestamps: true },
);
UserSchema.index({ email: 1 }, { unique: true });
