import { createServerFn } from "@tanstack/react-start";
import { adminCall } from "@/server/admin-api/instance";
import { AuditListInput } from "./inputs";

/**
 * Audit log of the token's tenant (run 48 A6.4). A GET server function (its input is in the URL):
 * allowed because the input is only enums, opaque ids and ISO times, and `AuditIdSchema` refuses an
 * email (`@`). Metadata is filtered again server-side (`AuditEventSchema`) before the browser.
 */
export const listAudit = createServerFn({ method: "GET" })
  .inputValidator(AuditListInput)
  .handler(({ data }) => adminCall((api, ctx) => api.listAudit(ctx, data)));
