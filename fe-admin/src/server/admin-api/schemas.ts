import "@tanstack/react-start/server-only";
import { z } from "zod";
import { AUDIT_RESULTS, AUTH_METHODS, CLIENT_TYPES, GRANT_TYPES } from "@/features/admin-api/inputs";

/**
 * Response schemas of the admin API (run 43 F1), mirroring the BE views (`admin.views.ts`, now in
 * the OpenAPI snapshot: `test/admin-schema-types.test.ts` fails `typecheck` when they drift). Zod
 * strips unknown keys: each schema is an allowlist, a field the BE adds never reaches the browser.
 */
export const AdminClientSchema = z.object({
  clientId: z.string(),
  tenantId: z.string(),
  clientType: z.enum(CLIENT_TYPES),
  tokenEndpointAuthMethod: z.enum(AUTH_METHODS),
  grantTypes: z.array(z.enum(GRANT_TYPES)),
  redirectUris: z.array(z.string()),
  postLogoutRedirectUris: z.array(z.string()),
  frontchannelLogoutUri: z.string().nullable(),
  allowedCorsOrigins: z.array(z.string()),
  allowedResources: z.array(z.string()),
  scopes: z.array(z.string()),
  disabled: z.boolean(),
  disabledAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type AdminClient = z.infer<typeof AdminClientSchema>;

export const ClientPageSchema = z.object({
  items: z.array(AdminClientSchema),
  nextCursor: z.string().nullable(),
});
export type ClientPage = z.infer<typeof ClientPageSchema>;

export const AdminResourceSchema = z.object({
  resourceId: z.string(),
  identifier: z.string(),
  scopes: z.array(z.string()),
});
export type AdminResource = z.infer<typeof AdminResourceSchema>;

export const ResourcePageSchema = z.object({
  items: z.array(AdminResourceSchema),
  nextCursor: z.string().nullable(),
});
export type ResourcePage = z.infer<typeof ResourcePageSchema>;

/** A secret version (`GET /admin/clients/{id}/secrets`): metadata only, never a hash or a secret. */
export const CredentialSchema = z.object({
  version: z.number().int().min(1),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  status: z.enum(["active", "grace", "expired", "revoked"]),
});
export type Credential = z.infer<typeof CredentialSchema>;

export const CredentialListSchema = z.object({ items: z.array(CredentialSchema) });
export type CredentialList = z.infer<typeof CredentialListSchema>;

/** `POST /admin/clients/{id}/secrets`: the only answer that ever holds the plaintext. */
export const IssuedSecretSchema = z.object({
  clientId: z.string(),
  version: z.number().int().min(1),
  clientSecret: z.string().min(1).max(512),
});
export type IssuedSecret = z.infer<typeof IssuedSecretSchema>;

/** A user of the token's tenant (`admin.views.ts` `AdminUserViewDto`): no hash, token or session ref. */
export const AdminUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  locked: z.boolean(),
  lockedUntil: z.string().nullable(),
  membershipStatus: z.enum(["active", "suspended"]),
  roles: z.array(z.string()),
  createdAt: z.string().nullable(),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

export const UserPageSchema = z.object({
  items: z.array(AdminUserSchema),
  nextCursor: z.string().nullable(),
});
export type UserPage = z.infer<typeof UserPageSchema>;

/** A refresh token family of a user (metadata only: never a token or its hash). */
export const AdminFamilySchema = z.object({
  familyId: z.string(),
  clientId: z.string(),
  resource: z.string(),
  scope: z.array(z.string()),
  createdAt: z.string(),
  lastRotatedAt: z.string(),
  expiresAt: z.string(),
  active: z.boolean(),
  revokedAt: z.string().nullable(),
});
export type AdminFamily = z.infer<typeof AdminFamilySchema>;

export const FamilyPageSchema = z.object({
  items: z.array(AdminFamilySchema),
  nextCursor: z.string().nullable(),
});
export type FamilyPage = z.infer<typeof FamilyPageSchema>;

/** An active consent of a user. */
export const AdminConsentSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  resource: z.string(),
  grantedScopes: z.array(z.string()),
  policyVersion: z.string().nullable(),
  termsVersion: z.string().nullable(),
  grantedAt: z.string(),
  updatedAt: z.string(),
});
export type AdminConsent = z.infer<typeof AdminConsentSchema>;

export const ConsentPageSchema = z.object({
  items: z.array(AdminConsentSchema),
  nextCursor: z.string().nullable(),
});
export type ConsentPage = z.infer<typeof ConsentPageSchema>;

/** Mirror of the BE `isSecretKey` (`audit.service.ts`) plus `hash`: lowercase, letters only. */
const SECRET_KEY_PATTERN = /password|secret|token|privatekey|cookie|authorization|verifier|hash/;
const SECRET_KEY_EXACT = new Set(["code", "authorizationcode"]);
const isSecretKey = (key: string) => {
  const k = key.toLowerCase().replace(/[^a-z]/g, "");
  return SECRET_KEY_EXACT.has(k) || SECRET_KEY_PATTERN.test(k);
};
export type AuditMetadata = Record<string, string | number | boolean | null>;

/**
 * Second filter of the audit metadata (run 48 F2), server-side, before the browser: only primitive
 * values under a non-secret-looking key. Old Mongo rows are `Mixed`; an odd shape never fails the page.
 */
function safeMetadata(raw: unknown): AuditMetadata | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const clean: AuditMetadata = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isSecretKey(key)) continue;
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) clean[key] = value as AuditMetadata[string];
  }
  return Object.keys(clean).length ? clean : null;
}

/**
 * An audit event of the token's tenant (`AdminAuditEventViewDto`; no `tenantId`, no `_id`).
 * `action`/`actorType` are plain strings: an action the BE adds later must not break the page.
 */
export const AuditEventSchema = z.object({
  eventId: z.string(),
  timestamp: z.string(),
  actorType: z.string(),
  actorId: z.string().nullish(),
  action: z.string(),
  targetType: z.string().nullish(),
  targetId: z.string().nullish(),
  clientId: z.string().nullish(),
  ip: z.string().nullish(),
  userAgent: z.string().nullish(),
  requestId: z.string().nullish(),
  result: z.enum(AUDIT_RESULTS),
  reason: z.string().nullish(),
  metadata: z.unknown().optional().transform(safeMetadata),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const AuditPageSchema = z.object({
  items: z.array(AuditEventSchema),
  nextCursor: z.string().nullable(),
});
export type AuditPage = z.infer<typeof AuditPageSchema>;

/**
 * A signing key of the IdP (`GET /admin/keys`, run 49 F2): metadata only. `z.object` strips, so a
 * key member (`n`, `e`, `d`, `p`, …), a PEM or a path the BE might add never reaches the browser.
 */
export const SigningKeySchema = z.object({
  kid: z.string().min(1).max(128),
  alg: z.string(),
  status: z.enum(["active", "retiring"]),
  createdAt: z.string(),
  retireAt: z.string().nullable(),
});
export type SigningKey = z.infer<typeof SigningKeySchema>;

/** Every key in the JWKS (one active + the retiring ones); never paged (`nextCursor` always null). */
export const SigningKeyListSchema = z.object({
  items: z.array(SigningKeySchema),
  nextCursor: z.null(),
});
export type SigningKeyList = z.infer<typeof SigningKeyListSchema>;

/** `POST /admin/keys/rotate`. */
export const RotateKeyResultSchema = z.object({
  newKid: z.string().min(1).max(128),
  oldKid: z.string().nullable(),
  mode: z.enum(["normal", "emergency"]),
});
export type RotateKeyResult = z.infer<typeof RotateKeyResultSchema>;
