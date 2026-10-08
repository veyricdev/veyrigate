import { Schema } from 'mongoose';

/** Client / relying party (spec §10). */
export const ClientSchema = new Schema(
  {
    clientId: { type: String, required: true },
    clientType: { type: String, required: true, enum: ['public', 'confidential'] },
    tokenEndpointAuthMethod: {
      type: String,
      required: true,
      enum: ['client_secret_basic', 'client_secret_post', 'none'],
    },
    // OAuth grant types this client may use at `/token` (Q4/D7). Default keeps existing clients
    // at `authorization_code` only; `refresh_token` must be granted explicitly (fail-closed B4.4).
    grantTypes: {
      type: [String],
      enum: ['authorization_code', 'refresh_token'],
      default: ['authorization_code'],
    },
    redirectUris: { type: [String], default: [] },
    // RP-initiated logout target(s) (D4). Same validation rule as redirectUris (INV-4).
    postLogoutRedirectUris: { type: [String], default: [] },
    allowedCorsOrigins: { type: [String], default: [] },
    allowedResources: { type: [String], default: [] },
    scopes: { type: [String], default: [] },
    tenantId: { type: String, required: true },
  },
  { timestamps: true },
);
ClientSchema.index({ clientId: 1 }, { unique: true });
