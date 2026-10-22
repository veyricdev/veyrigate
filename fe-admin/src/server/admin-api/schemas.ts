import "@tanstack/react-start/server-only";
import { z } from "zod";

/**
 * Response schemas of the admin API (run 43 F1). The BE OpenAPI has no response schemas
 * (DEBT-290), so these are written by hand from `be/src/modules/admin/admin.mappers.ts`. Zod strips
 * unknown keys: each schema is an allowlist, a field the BE adds never reaches the browser.
 */
export const AdminClientSchema = z.object({
  clientId: z.string(),
  tenantId: z.string(),
  clientType: z.string(),
  tokenEndpointAuthMethod: z.string(),
  grantTypes: z.array(z.string()),
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
