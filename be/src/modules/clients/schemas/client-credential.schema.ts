import { Schema } from 'mongoose';

/** ClientCredential (spec §10, INV-18) — only the secret hash is stored. */
export const ClientCredentialSchema = new Schema({
  clientId: { type: String, required: true },
  secretHash: { type: String, required: true },
  version: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date },
  revokedAt: { type: Date },
});
ClientCredentialSchema.index({ clientId: 1, version: 1 });
