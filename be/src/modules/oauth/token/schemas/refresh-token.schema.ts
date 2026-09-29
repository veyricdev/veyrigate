import { Schema } from 'mongoose';

/**
 * RefreshToken (spec §10, INV-10/11/12). Looked up by `tokenHash` (sha256),
 * never by a guessable id. TTL index removes documents once `expiresAt` passes.
 */
export const RefreshTokenSchema = new Schema({
  tokenHash: { type: String, required: true },
  familyId: { type: String, required: true },
  parentId: { type: Schema.Types.ObjectId },
  userId: { type: Schema.Types.ObjectId, required: true },
  clientId: { type: String, required: true },
  scope: { type: [String], default: [] },
  resource: { type: String, required: true },
  issuedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date },
  replacedBy: { type: Schema.Types.ObjectId },
  reuseDetectedAt: { type: Date },
  deviceId: { type: String },
  ip: { type: String },
  userAgent: { type: String },
});
RefreshTokenSchema.index({ tokenHash: 1 }, { unique: true });
RefreshTokenSchema.index({ userId: 1, clientId: 1 });
RefreshTokenSchema.index({ familyId: 1 });
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
