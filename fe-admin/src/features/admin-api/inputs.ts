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

export const ListClientsInput = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  after: z.string().min(1).max(2048).optional(),
});
export type ListClientsParams = z.infer<typeof ListClientsInput>;

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
