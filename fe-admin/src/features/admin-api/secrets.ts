import { createServerFn } from "@tanstack/react-start";
import { adminCall, setNoStore } from "@/server/admin-api/instance";
import { ClientIdSchema, RevokeSecretInput } from "./inputs";

/**
 * Client secret server functions (run 45 A6.1b), confidential clients only (the BE refuses the
 * others). The plaintext of an issued secret crosses this boundary once and is never logged.
 */

export const listSecrets = createServerFn({ method: "GET" })
  .inputValidator(ClientIdSchema)
  .handler(({ data }) => adminCall((api, ctx) => api.listSecrets(ctx, data)));

/**
 * `POST /admin/clients/{id}/secrets` (create or rotate; needs a recent sign-in). Not for
 * `useMutation`: its result must only live in the dialog's state (run 45 F3.1).
 */
export const issueSecret = createServerFn({ method: "POST" })
  .inputValidator(ClientIdSchema)
  .handler(({ data }) => {
    setNoStore(); // also on a failure: one rule for every answer of this function
    return adminCall((api, ctx) => api.issueSecret(ctx, data));
  });

/** `DELETE /admin/clients/{id}/secrets/{version}` (immediate, no grace; needs a recent sign-in). */
export const revokeSecret = createServerFn({ method: "POST" })
  .inputValidator(RevokeSecretInput)
  .handler(({ data }) => adminCall((api, ctx) => api.revokeSecret(ctx, data.clientId, data.version)));
