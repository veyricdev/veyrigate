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
    // OIDC front-channel logout endpoint (spec §9.8, B4.7). The IdP loads this in a hidden
    // iframe on logout so the RP clears its own session. Same format rule as redirectUris
    // (https/absolute/no fragment/no wildcard, INV-4); optional (absent → not notified).
    frontchannelLogoutUri: { type: String },
    allowedCorsOrigins: { type: [String], default: [] },
    allowedResources: { type: [String], default: [] },
    scopes: { type: [String], default: [] },
    tenantId: { type: String, required: true },
    // Admin disable (B6.3a, Q-27.4): non-null => the client cannot authorize/authenticate and its
    // access tokens are inactive (`ClientService.findByClientId` filters `disabledAt: null`, which
    // also matches older documents without the field). Reversible; there is no DELETE.
    disabledAt: { type: Date, default: null },
  },
  { timestamps: true },
);
ClientSchema.index({ clientId: 1 }, { unique: true });
// B6.3a: admin list/get always filter by `tenantId` and page by `clientId`.
ClientSchema.index({ tenantId: 1, clientId: 1 });
// DEBT-020: `isOriginRegisteredForAnyClient` (discovery/jwks/preflight CORS) queries by
// `allowedCorsOrigins`; a multikey index avoids a full collection scan per preflight/metadata hit.
ClientSchema.index({ allowedCorsOrigins: 1 });
