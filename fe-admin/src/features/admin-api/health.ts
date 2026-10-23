import { createServerFn } from "@tanstack/react-start";
import { adminCall } from "@/server/admin-api/instance";

/**
 * IdP readiness for the dashboard (run 50 A6.6): signed-in admins only (`adminCall` checks the
 * session; no session => no BE request). No input. The browser gets `up` | `down` | `unknown` only.
 */
export const getBackendHealth = createServerFn({ method: "GET" }).handler(() =>
  adminCall((api, ctx) => api.readiness(ctx)),
);
