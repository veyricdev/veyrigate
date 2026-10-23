import { createServerFn } from "@tanstack/react-start";
import { adminCall } from "@/server/admin-api/instance";
import { RotateKeyInput } from "./inputs";

/**
 * Signing keys of the IdP (run 49 A6.5): super_admin only (the BE refuses anyone else, reads
 * included). Metadata only: `SigningKeySchema` strips any key material before the browser.
 */
export const listSigningKeys = createServerFn({ method: "GET" }).handler(() =>
  adminCall((api, ctx) => api.listSigningKeys(ctx)),
);

/** Normal or emergency rotation (`admin.write` + recent sign-in). Not idempotent: never re-sent. */
export const rotateSigningKey = createServerFn({ method: "POST" })
  .inputValidator(RotateKeyInput)
  .handler(({ data }) => adminCall((api, ctx) => api.rotateSigningKey(ctx, data.mode)));
