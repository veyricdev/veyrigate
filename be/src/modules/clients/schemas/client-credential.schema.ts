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
// DEBT-021: unique so two credentials of the same client can never share a version number (a
// concurrent createSecret/rotateSecret retries on E11000). `revokeSecret(clientId, version)` then
// addresses exactly one credential.
ClientCredentialSchema.index({ clientId: 1, version: 1 }, { unique: true });
