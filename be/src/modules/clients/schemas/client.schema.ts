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
