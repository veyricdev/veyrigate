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
  // sha256 of the session cookie id (= `Session.ref`) that minted this family. Lets a local
  // logout revoke only the refresh tokens of THIS browser session (B4.7, tech-lead OPEN-1). Not
  // reversible. Since DEBT-037 it IS surfaced as the access token `sid` claim (a JWT the RP/RS can
  // read) — a public identifier, never a credential, and never in the `/introspect` response body.
  // Filter `{userId, sessionRef}` is a prefix of the `{userId:1, clientId:1}` index (no new index).
  // Tokens minted before B4.7 have none and are only reachable by global logout / `/revoke` / TTL.
  sessionRef: { type: String },
  scope: { type: [String], default: [] },
  resource: { type: String, required: true },
  issuedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date },
  replacedBy: { type: Schema.Types.ObjectId },
  reuseDetectedAt: { type: Date },
  // Stamped by EVERY family revoke (reuse AND /revoke) before the revoke updateMany, so a
  // concurrent rotate can re-read it after minting its successor and self-revoke (INV-11 race close).
  familyRevokedAt: { type: Date },
  deviceId: { type: String },
  ip: { type: String },
  userAgent: { type: String },
});
RefreshTokenSchema.index({ tokenHash: 1 }, { unique: true });
RefreshTokenSchema.index({ userId: 1, clientId: 1 });
RefreshTokenSchema.index({ familyId: 1 });
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
