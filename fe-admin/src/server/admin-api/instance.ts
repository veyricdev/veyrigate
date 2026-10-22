import "@tanstack/react-start/server-only";
import { getRequest, getResponseHeaders } from "@tanstack/react-start/server";
import type { AdminResult } from "@/features/admin-api/types";
import { getAuth } from "../auth/instance";
import { serverEnv } from "../env";
import { AdminApiError, createAdminApi, type AdminApi, type AdminCallContext } from "./client";

let api: AdminApi | undefined;

function getAdminApi(): AdminApi {
  api ??= createAdminApi({ baseUrl: serverEnv().ADMIN_API_BASE_URL, fetch: globalThis.fetch, auth: getAuth() });
  return api;
}

/**
 * Body of an admin server function: runs `fn` for the current request and returns a typed failure
 * as a value (a thrown error would reach the browser as its message only). Anything else throws to
 * the server function boundary (generic 500/503).
 */
export async function adminCall<T>(fn: (api: AdminApi, ctx: AdminCallContext) => Promise<T>): Promise<AdminResult<T>> {
  const ctx: AdminCallContext = {
    request: getRequest(),
    // append: never drop a Set-Cookie another part of the request wrote (DEBT-287)
    setCookie: (value) => getResponseHeaders().append("set-cookie", value),
  };
  try {
    return { ok: true, data: await fn(getAdminApi(), ctx) };
  } catch (err) {
    if (err instanceof AdminApiError) return { ok: false, error: err.toFailure() };
    throw err;
  }
}
