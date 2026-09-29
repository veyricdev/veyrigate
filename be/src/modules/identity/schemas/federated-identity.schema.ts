import { Schema } from 'mongoose';

/** FederatedIdentity (spec §10) — separate collection, linked to a User. */
export const FederatedIdentitySchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  provider: { type: String, required: true },
  providerId: { type: String, required: true },
  email: { type: String },
  emailVerified: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  lastLoginAt: { type: Date },
});
FederatedIdentitySchema.index({ provider: 1, providerId: 1 }, { unique: true });
