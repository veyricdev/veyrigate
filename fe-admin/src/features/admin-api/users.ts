import { createServerFn } from "@tanstack/react-start";
import { adminCall } from "@/server/admin-api/instance";
import { RevokeConsentInput, RevokeFamilyInput, UserIdSchema, UserListInput, UserPageInput } from "./inputs";

/**
 * Admin API server functions for users (run 47 A6.3): one fixed BE endpoint each, input validated
 * by zod. Reads need `admin.read`; every write needs `admin.write` + a recent sign-in (may answer
 * `step_up_required`), and a tenant_admin may not touch an admin or a multi-tenant account
 * (`forbidden`). Lock, unlock and revoke-all act on the GLOBAL account (every tenant).
 */

/**
 * A read, but a POST server function: a GET one encodes its input in the URL, and the email filter
 * must never reach a URL, the history, a log or `returnTo` (run 47 F2).
 */
export const listUsers = createServerFn({ method: "POST" })
  .inputValidator(UserListInput)
  .handler(({ data }) => adminCall((api, ctx) => api.listUsers(ctx, data)));

export const getUser = createServerFn({ method: "GET" })
  .inputValidator(UserIdSchema)
  .handler(({ data }) => adminCall((api, ctx) => api.getUser(ctx, data)));

export const listUserFamilies = createServerFn({ method: "GET" })
  .inputValidator(UserPageInput)
  .handler(({ data }) => adminCall((api, ctx) => api.listUserFamilies(ctx, data)));

export const listUserConsents = createServerFn({ method: "GET" })
  .inputValidator(UserPageInput)
  .handler(({ data }) => adminCall((api, ctx) => api.listUserConsents(ctx, data)));

/** Lock (applied first, then every credential revoked: a 5xx may follow an applied lock). */
export const lockUser = createServerFn({ method: "POST" })
  .inputValidator(UserIdSchema)
  .handler(({ data }) => adminCall((api, ctx) => api.lockUser(ctx, data)));

export const unlockUser = createServerFn({ method: "POST" })
  .inputValidator(UserIdSchema)
  .handler(({ data }) => adminCall((api, ctx) => api.unlockUser(ctx, data)));

/** Ends every session and refresh family of the user, in every tenant (idempotent). */
export const revokeUserSessions = createServerFn({ method: "POST" })
  .inputValidator(UserIdSchema)
  .handler(({ data }) => adminCall((api, ctx) => api.revokeUserSessions(ctx, data)));

/** Idempotent. */
export const revokeUserFamily = createServerFn({ method: "POST" })
  .inputValidator(RevokeFamilyInput)
  .handler(({ data }) => adminCall((api, ctx) => api.revokeUserFamily(ctx, data.userId, data.familyId)));

/** Not idempotent (an already revoked consent is `not_found`). */
export const revokeUserConsent = createServerFn({ method: "POST" })
  .inputValidator(RevokeConsentInput)
  .handler(({ data }) => adminCall((api, ctx) => api.revokeUserConsent(ctx, data.userId, data.consentId)));
