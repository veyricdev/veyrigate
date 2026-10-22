import { createServerFn } from "@tanstack/react-start";
import { adminCall, adminResourceIdentifier } from "@/server/admin-api/instance";
import { ClientIdSchema, CreateClientInput, ListClientsInput, UpdateClientInput } from "./inputs";

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

/** `POST /admin/clients` (needs a recent sign-in: may answer `step_up_required`). */
export const createClient = createServerFn({ method: "POST" })
  .inputValidator(CreateClientInput)
  .handler(({ data }) => adminCall((api, ctx) => api.createClient(ctx, data)));

/** `PATCH /admin/clients/{id}` (needs a recent sign-in: may answer `step_up_required`). */
export const updateClient = createServerFn({ method: "POST" })
  .inputValidator(UpdateClientInput)
  .handler(({ data }) => adminCall((api, ctx) => api.updateClient(ctx, data.clientId, data.patch)));

/**
 * Resources a client may be allowed (first 100). `adminCapable` marks the admin API resource
 * (display only: the BE decides who may grant it); the issuer itself never reaches the browser.
 */
export const listResources = createServerFn({ method: "GET" }).handler(() =>
  adminCall(async (api, ctx) => {
    const admin = adminResourceIdentifier();
    const page = await api.listResources(ctx);
    return page.items.map((r) => ({ ...r, adminCapable: r.identifier === admin }));
  }),
);
