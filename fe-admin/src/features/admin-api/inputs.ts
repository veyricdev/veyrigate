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

const uriList = z.array(z.string().max(2048)).max(20);

/** `PATCH /admin/clients/{id}` body (BE `UpdateClientDto`, which rejects unknown keys). */
export const ClientPatchSchema = z
  .object({
    grantTypes: z.array(z.enum(["authorization_code", "refresh_token"])).max(20).optional(),
    redirectUris: uriList.optional(),
    postLogoutRedirectUris: uriList.optional(),
    allowedCorsOrigins: uriList.optional(),
    allowedResources: z.array(z.string().max(2048)).max(20).optional(),
    scopes: z.array(z.string().max(2048)).max(20).optional(),
    frontchannelLogoutUri: z.string().max(2048).nullable().optional(),
    disabled: z.boolean().optional(),
  })
  .strict();

export const UpdateClientInput = z.object({ clientId: ClientIdSchema, patch: ClientPatchSchema });
export type UpdateClientParams = z.infer<typeof UpdateClientInput>;
