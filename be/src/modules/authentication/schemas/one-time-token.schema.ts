import { Schema } from 'mongoose';

/**
 * Shape shared by PasswordResetToken and EmailVerificationToken (spec §10,
 * §9.12): hashed, single-use (`usedAt`), auto-removed by TTL on `expiresAt`.
 */
function createOneTimeTokenSchema(): Schema {
  const schema = new Schema({
    tokenHash: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    /** Password attempts on `/verify-email` (run 91, D91.14): 5 wrong ones burn the token. */
    attempts: { type: Number },
  });
  schema.index({ tokenHash: 1 }, { unique: true });
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  return schema;
}

export const PasswordResetTokenSchema = createOneTimeTokenSchema();
export const EmailVerificationTokenSchema = createOneTimeTokenSchema();
