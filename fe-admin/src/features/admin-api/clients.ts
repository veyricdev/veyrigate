import { createServerFn } from "@tanstack/react-start";
import { adminCall } from "@/server/admin-api/instance";
import { ClientIdSchema, ListClientsInput, UpdateClientInput } from "./inputs";

/**
 * Admin API server functions for clients (run 43 F2): thin, one fixed BE endpoint each (no generic
 * proxy), input validated by zod. They return {@link AdminResult}; never a token or a raw BE body.
 */

export const listClients = createServerFn({ method: "GET" })
  .inputValidator(ListClientsInput)
  .handler(({ data }) => adminCall((api, ctx) => api.listClients(ctx, data)));

export const getClient = createServerFn({ method: "GET" })
  .inputValidator(ClientIdSchema)
  .handler(({ data }) => adminCall((api, ctx) => api.getClient(ctx, data)));

/** `PATCH /admin/clients/{id}` (needs a recent sign-in: may answer `step_up_required`). */
export const updateClient = createServerFn({ method: "POST" })
  .inputValidator(UpdateClientInput)
  .handler(({ data }) => adminCall((api, ctx) => api.updateClient(ctx, data.clientId, data.patch)));
