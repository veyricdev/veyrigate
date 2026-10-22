import "@tanstack/react-start/server-only";
import { z } from "zod";
import { AUTH_METHODS, CLIENT_TYPES, GRANT_TYPES } from "@/features/admin-api/inputs";

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
