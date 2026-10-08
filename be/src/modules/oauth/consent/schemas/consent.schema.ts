import { Schema } from 'mongoose';

/** Consent store registration (spec §9.4, §10). Granularity user × client (Q1 still open). */
export const ConsentSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  clientId: { type: String, required: true },
  resource: { type: String, default: '' },
  grantedScopes: { type: [String], default: [] },
  policyVersion: { type: String },
  termsVersion: { type: String },
  grantedAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  revokedAt: { type: Date },
});
ConsentSchema.index({ userId: 1, clientId: 1, resource: 1 }, { unique: true });
