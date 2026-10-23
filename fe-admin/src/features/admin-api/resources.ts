import { createServerFn } from "@tanstack/react-start";
import { adminCall } from "@/server/admin-api/instance";
import { CreateResourceInput, PageInput, ResourcePathIdSchema, UpdateResourceInput } from "./inputs";

/**
 * Admin API server functions for resources (run 46 A6.2): one fixed BE endpoint each, input
 * validated by zod. Resources are global: reads need `admin.read`; writes need super_admin and a
 * recent sign-in (may answer `step_up_required` / `forbidden`). The client form's options stay
 * `listResources` (`clients.ts`).
 */

export const listResourcePage = createServerFn({ method: "GET" })
  .inputValidator(PageInput)
  .handler(({ data }) => adminCall((api, ctx) => api.listResourcePage(ctx, data)));

export const getResource = createServerFn({ method: "GET" })
  .inputValidator(ResourcePathIdSchema)
  .handler(({ data }) => adminCall((api, ctx) => api.getResource(ctx, data)));

/** `POST /admin/resources` (not idempotent: a timeout/5xx is `uncertain`, never re-sent). */
export const createResource = createServerFn({ method: "POST" })
  .inputValidator(CreateResourceInput)
  .handler(({ data }) => adminCall((api, ctx) => api.createResource(ctx, data)));

/** `PATCH /admin/resources/{id}` (body: `{ scopes }` only). */
export const updateResource = createServerFn({ method: "POST" })
  .inputValidator(UpdateResourceInput)
  .handler(({ data }) => adminCall((api, ctx) => api.updateResource(ctx, data.resourceId, data.patch)));
