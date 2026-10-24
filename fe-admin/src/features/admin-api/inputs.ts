import { z } from "@/lib/zod";

/**
 * Server function inputs (run 43 F2), validated on both sides by `.inputValidator`. A path id can
 * never carry a path segment (`/`, `\`, `.`, `..`); it is still `encodeURIComponent`-ed server-side.
 */
export const pathIdSchema = (message: string) =>
  z
    .string()
    .min(1)
    .max(128)
    .refine((v) => !/[/\\]/.test(v) && v !== "." && v !== "..", message);

export const ClientIdSchema = pathIdSchema("Invalid client id");

/** Cursor page input of a list endpoint (`limit` 1..100, `after` = the BE cursor). */
export const PageInput = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  after: z.string().min(1).max(2048).optional(),
});
export type PageParams = z.infer<typeof PageInput>;
export const ListClientsInput = PageInput;
export type ListClientsParams = PageParams;

export const CLIENT_TYPES = ["public", "confidential"] as const;
export const AUTH_METHODS = ["none", "client_secret_basic", "client_secret_post"] as const;
export const GRANT_TYPES = ["authorization_code", "refresh_token"] as const;

const uriList = z.array(z.string().max(2048)).max(20);

/** Fields shared by create and update (BE `ClientFieldsDto`). */
const clientFields = {
  grantTypes: z.array(z.enum(GRANT_TYPES)).max(20).optional(),
  redirectUris: uriList.optional(),
  postLogoutRedirectUris: uriList.optional(),
  allowedCorsOrigins: uriList.optional(),
  allowedResources: z.array(z.string().max(2048)).max(20).optional(),
  scopes: z.array(z.string().max(2048)).max(20).optional(),
};

/** `PATCH /admin/clients/{id}` body (BE `UpdateClientDto`, which rejects unknown keys). */
export const ClientPatchSchema = z
  .object({
    ...clientFields,
    frontchannelLogoutUri: z.string().max(2048).nullable().optional(),
    disabled: z.boolean().optional(),
  })
  .strict();

export const UpdateClientInput = z.object({ clientId: ClientIdSchema, patch: ClientPatchSchema });
export type UpdateClientParams = z.infer<typeof UpdateClientInput>;

/** `POST /admin/clients` body (BE `CreateClientDto`; `clientId` is server-generated, no secret). */
export const CreateClientInput = z
  .object({
    clientType: z.enum(CLIENT_TYPES),
    tokenEndpointAuthMethod: z.enum(AUTH_METHODS),
    ...clientFields,
    frontchannelLogoutUri: z.string().max(2048).optional(),
  })
  .strict();
export type CreateClientParams = z.infer<typeof CreateClientInput>;

/** `DELETE /admin/clients/{id}/secrets/{version}` (BE path rule `^[1-9][0-9]{0,8}$`). */
export const RevokeSecretInput = z.object({
  clientId: ClientIdSchema,
  version: z.number().int().min(1).max(999_999_999),
});
export type RevokeSecretParams = z.infer<typeof RevokeSecretInput>;

/**
 * A resource id in a path: the same loose rule as {@link ClientIdSchema} (NOT the create regex),
 * so a seeded or older resource outside {@link RESOURCE_ID} can still be opened.
 */
export const ResourcePathIdSchema = pathIdSchema("Invalid resource id");

/** New resource id (BE `RESOURCE_ID`, `be/src/modules/admin/admin.dto.ts`). */
export const RESOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Resource scopes (BE `MAX_RESOURCE_SCOPES` / per-scope length; NOT the client limits). */
export const RESOURCE_SCOPES_MAX = 50;
export const RESOURCE_SCOPE_MAX_LEN = 256;
export const RESOURCE_IDENTIFIER_MAX_LEN = 2048;

const resourceScopes = z.array(z.string().min(1).max(RESOURCE_SCOPE_MAX_LEN).regex(/^\S+$/)).max(RESOURCE_SCOPES_MAX);

/** `POST /admin/resources` body (BE `CreateResourceDto`). */
export const CreateResourceInput = z
  .object({
    resourceId: z.string().regex(RESOURCE_ID),
    identifier: z.string().min(1).max(RESOURCE_IDENTIFIER_MAX_LEN),
    scopes: resourceScopes,
  })
  .strict();
export type CreateResourceParams = z.infer<typeof CreateResourceInput>;

/** `PATCH /admin/resources/{id}`: `scopes` only (replaces the whole list; `[]` is valid). */
export const UpdateResourceInput = z.object({
  resourceId: ResourcePathIdSchema,
  patch: z.object({ scopes: resourceScopes }).strict(),
});
export type UpdateResourceParams = z.infer<typeof UpdateResourceInput>;

/** A user id in a path: the BE `sub` (24 hex); anything else is never sent. */
export const UserIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid user id");
/** BE `FAMILY_ID` (`admin-users.controller.ts`). */
export const FamilyIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,128}$/, "Invalid family id");
export const ConsentIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid consent id");

export const USER_STATUSES = ["active", "suspended"] as const;

/** `GET /admin/users` filters (BE `UserListQueryDto`): exact email (never in a URL: POST fn), membership status. */
export const UserListInput = PageInput.extend({
  email: z.string().trim().min(1).max(320).optional(),
  status: z.enum(USER_STATUSES).optional(),
}).strict();
export type UserListParams = z.infer<typeof UserListInput>;

/** One page of a user's families or consents. */
export const UserPageInput = PageInput.extend({ userId: UserIdSchema });
export type UserPageParams = z.infer<typeof UserPageInput>;

export const RevokeFamilyInput = z.object({ userId: UserIdSchema, familyId: FamilyIdSchema });
export type RevokeFamilyParams = z.infer<typeof RevokeFamilyInput>;

export const RevokeConsentInput = z.object({ userId: UserIdSchema, consentId: ConsentIdSchema });
export type RevokeConsentParams = z.infer<typeof RevokeConsentInput>;

/** BE `AuditAction` (`audit-action.enum.ts`); `test/admin-schema-types.test.ts` fails `typecheck` on drift. */
export const AUDIT_ACTIONS = [
  "AUTH_LOGIN_SUCCESS",
  "AUTH_LOGIN_FAILED",
  "AUTH_ACCOUNT_LOCKED",
  "AUTH_EMAIL_VERIFIED",
  "AUTH_PASSWORD_RESET",
  "SESSION_CREATED",
  "SESSION_REVOKED",
  "OAUTH_AUTHORIZE",
  "OAUTH_CONSENT_GRANTED",
  "OAUTH_CONSENT_DENIED",
  "TOKEN_ISSUED",
  "TOKEN_REFRESHED",
  "TOKEN_REUSE_DETECTED",
  "TOKEN_REVOKED",
  "CLIENT_SECRET_CREATED",
  "CLIENT_SECRET_ROTATED",
  "CLIENT_SECRET_REVOKED",
  "REDIRECT_URI_CHANGED",
  "SIGNING_KEY_CREATED",
  "SIGNING_KEY_ROTATED",
  "ACCOUNT_LINKED",
  "ACCOUNT_UNLINKED",
  "ADMIN_CLIENT_CREATED",
  "ADMIN_CLIENT_UPDATED",
  "ADMIN_RESOURCE_CREATED",
  "ADMIN_RESOURCE_UPDATED",
  "ADMIN_USER_LOCKED",
  "ADMIN_USER_UNLOCKED",
  "ADMIN_USER_ROLES_CHANGED",
  "OAUTH_CONSENT_REVOKED",
] as const;
/** `targetType` values the BE writes today (free string in the BE query: this is the UI choice). */
export const AUDIT_TARGET_TYPES = ["user", "client", "resource", "session", "signing_key"] as const;
export const AUDIT_RESULTS = ["success", "failure"] as const;

/**
 * An audit filter id (actor, target, client): opaque ids only. No `@`, no space: an email pasted
 * here is refused before it can reach a URL, `returnTo` or the BE (run 48 Q-48.1).
 */
export const AuditIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/, "Invalid id");
/** The BE cursor (base64url JSON). */
export const AuditCursorSchema = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/);
export const AuditTimeSchema = z.iso.datetime({ offset: true });

/** `GET /admin/audit` filters (BE `AuditQueryDto`). Never a `tenantId`: the BE takes it from the token. */
export const AuditListInput = z
  .object({
    limit: z.number().int().min(1).max(100),
    after: AuditCursorSchema,
    action: z.enum(AUDIT_ACTIONS),
    actorId: AuditIdSchema,
    targetType: z.enum(AUDIT_TARGET_TYPES),
    targetId: AuditIdSchema,
    clientId: AuditIdSchema,
    result: z.enum(AUDIT_RESULTS),
    from: AuditTimeSchema,
    to: AuditTimeSchema,
  })
  .partial()
  .strict()
  .refine((p) => !p.from || !p.to || Date.parse(p.from) < Date.parse(p.to), {
    message: "'from' must be before 'to'",
    path: ["to"],
  });
export type AuditListParams = z.infer<typeof AuditListInput>;

export const ROTATION_MODES = ["normal", "emergency"] as const;
/** `POST /admin/keys/rotate` body (BE `RotateKeyDto`): `mode` is required, nothing else. */
export const RotateKeyInput = z.object({ mode: z.enum(ROTATION_MODES) }).strict();
export type RotateKeyParams = z.infer<typeof RotateKeyInput>;
