import { z } from "zod";

/**
 * Server function inputs (run 43 F2), validated on both sides by `.inputValidator`. A path id can
 * never carry a path segment (`/`, `\`, `.`, `..`); it is still `encodeURIComponent`-ed server-side.
 */
export const ClientIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((v) => !/[/\\]/.test(v) && v !== "." && v !== "..", "Invalid client id");

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
export const ResourcePathIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((v) => !/[/\\]/.test(v) && v !== "." && v !== "..", "Invalid resource id");

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
