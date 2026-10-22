import "@tanstack/react-start/server-only";
import type { z } from "zod";
import type { AdminApiErrorCode, AdminApiFailure } from "@/features/admin-api/types";
import type { CreateClientParams, ListClientsParams } from "@/features/admin-api/inputs";
import type { Auth } from "../auth/bff";
import { PublicError, logServerError } from "../errors";
import { fetchWithTimeout, type FetchFn } from "../oidc/discovery";
import type { components } from "./schema";
import {
  AdminClientSchema,
  ClientPageSchema,
  ResourcePageSchema,
  type AdminClient,
  type ClientPage,
  type ResourcePage,
} from "./schemas";

/**
 * Server-side admin API client (plan A5, run 43 F2). No generic proxy: each method calls one fixed
 * endpoint with a fixed method; ids are validated by the server function and URI-encoded here.
 * The access token comes from the session (refreshed by the BFF) and never leaves this module.
 */

const STATUS: Record<AdminApiErrorCode, number> = {
  unauthenticated: 401,
  step_up_required: 403,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  conflict: 409,
  unavailable: 503,
};

const MESSAGES: Record<AdminApiErrorCode, string> = {
  unauthenticated: "Your session has ended. Please sign in again.",
  step_up_required: "Please confirm your identity to continue.",
  forbidden: "You do not have permission to do this.",
  not_found: "Not found.",
  invalid_request: "The request was rejected.",
  conflict: "The request conflicts with the current state.",
  unavailable: "The admin service is temporarily unavailable. Please try again.",
};

/** A typed, already-sanitised admin API failure (fixed message, or the BE 400/409 description). */
export class AdminApiError extends PublicError {
  constructor(
    readonly code: AdminApiErrorCode,
    message: string = MESSAGES[code],
    readonly uncertain?: true,
  ) {
    super(message, STATUS[code]);
    this.name = "AdminApiError";
  }

  toFailure(): AdminApiFailure {
    return { code: this.code, message: this.message, ...(this.uncertain ? { uncertain: true as const } : {}) };
  }
}

/** Where the BFF writes Set-Cookie for this request (session cleared). */
export interface AdminCallContext {
  request: Request;
  setCookie(value: string): void;
}

/** `UpdateClientDto` from the OpenAPI snapshot. */
export type ClientPatch = components["schemas"]["UpdateClientDto"];

type Method = "GET" | "POST" | "PATCH";
interface Operation<T> {
  method: Method;
  /** Route template for logs (never the concrete id). */
  route: string;
  path: string;
  body?: unknown;
  schema: z.ZodType<T>;
}

export interface AdminApiDeps {
  baseUrl: string;
  fetch: FetchFn;
  auth: Pick<Auth, "accessToken" | "refreshRejected" | "dropSession">;
  timeoutMs?: number;
}

const DESCRIPTION_MAX = 200;

export function createAdminApi(deps: AdminApiDeps) {
  const base = deps.baseUrl.replace(/\/+$/, "");
  const timeoutMs = deps.timeoutMs ?? 10_000;

  const unavailable = (op: Operation<unknown>, err: unknown, uncertain: boolean) => {
    logServerError(`admin api ${op.method} ${op.route}`, err);
    return new AdminApiError("unavailable", undefined, uncertain ? true : undefined);
  };

  /** One HTTP call, never retried here (Query retries GETs; a mutation is never re-sent blindly). */
  async function send(op: Operation<unknown>, token: string): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
    if (op.body !== undefined) headers["content-type"] = "application/json";
    try {
      return await fetchWithTimeout(
        deps.fetch,
        `${base}${op.path}`,
        { method: op.method, headers, body: op.body === undefined ? undefined : JSON.stringify(op.body) },
        timeoutMs,
      );
    } catch (err) {
      throw unavailable(op, err, op.method !== "GET");
    }
  }

  async function read<T>(op: Operation<T>, res: Response): Promise<T> {
    const status = res.status;
    if (status >= 200 && status < 300) {
      // A 2xx mutation was applied even when its body is unusable: report it as `uncertain` so the
      // UI re-reads instead of re-sending (DEBT-297). Never log the body (it may hold a secret).
      const mutation = op.method !== "GET";
      const body: unknown = await res.json().catch(() => undefined);
      if (body === undefined) throw unavailable(op, new Error(`HTTP ${status}: body is not JSON`), mutation);
      const parsed = op.schema.safeParse(body);
      if (parsed.success) return parsed.data;
      if (mutation) throw unavailable(op, new Error(`HTTP ${status}: response schema mismatch`), true);
      // A GET off contract is a bug, not an outage: generic 500 (logged by the boundary).
      throw new Error(`admin api ${op.method} ${op.route}: response schema mismatch`);
    }
    if (status >= 500) throw unavailable(op, new Error(`HTTP ${status}`), op.method !== "GET");
    if (status < 400) throw unavailable(op, new Error(`HTTP ${status}`), false); // 3xx (redirect: manual)
    const body = (await res.json().catch(() => null)) as { error?: unknown; error_description?: unknown } | null;
    if (body === null) throw unavailable(op, new Error(`HTTP ${status}: body is not JSON`), false);
    const description =
      typeof body.error_description === "string" ? body.error_description.slice(0, DESCRIPTION_MAX) : undefined;
    const code = `${status} ${String(body.error)}`;
    if (code === "403 step_up_required") throw new AdminApiError("step_up_required");
    if (code === "403 forbidden" || code === "403 insufficient_scope") throw new AdminApiError("forbidden");
    if (code === "404 not_found") throw new AdminApiError("not_found");
    if (code === "400 invalid_request") throw new AdminApiError("invalid_request", description);
    if (code === "409 conflict") throw new AdminApiError("conflict", description);
    throw new Error(`admin api ${op.method} ${op.route}: HTTP ${status}`);
  }

  async function call<T>(ctx: AdminCallContext, op: Operation<T>): Promise<T> {
    const at = await deps.auth.accessToken(ctx.request);
    if (at.setCookie) ctx.setCookie(at.setCookie);
    if (!at.session) throw new AdminApiError("unauthenticated");
    const { key, token } = at.session;
    let res = await send(op, token);
    if (res.status === 401) {
      // The guard refused before the handler ran, so re-sending (even a mutation) is safe: one
      // forced refresh, one retry; still refused => the session is over.
      const fresh = await deps.auth.refreshRejected(key, token);
      if (fresh) res = await send(op, fresh);
      if (!fresh || res.status === 401) {
        ctx.setCookie(await deps.auth.dropSession(key));
        throw new AdminApiError("unauthenticated");
      }
    }
    return read(op, res);
  }

  const clientPath = (clientId: string) => `/admin/clients/${encodeURIComponent(clientId)}`;

  return {
    listClients(ctx: AdminCallContext, params: ListClientsParams): Promise<ClientPage> {
      const q = new URLSearchParams();
      if (params.limit !== undefined) q.set("limit", String(params.limit));
      if (params.after !== undefined) q.set("after", params.after);
      const qs = q.size ? `?${q}` : "";
      return call(ctx, { method: "GET", route: "/admin/clients", path: `/admin/clients${qs}`, schema: ClientPageSchema });
    },
    getClient(ctx: AdminCallContext, clientId: string): Promise<AdminClient> {
      return call(ctx, {
        method: "GET",
        route: "/admin/clients/:clientId",
        path: clientPath(clientId),
        schema: AdminClientSchema,
      });
    },
    /** `POST /admin/clients` (not idempotent: never re-sent; a timeout/5xx is `uncertain`). */
    createClient(ctx: AdminCallContext, body: CreateClientParams): Promise<AdminClient> {
      return call(ctx, { method: "POST", route: "/admin/clients", path: "/admin/clients", body, schema: AdminClientSchema });
    },
    /** First page (≤ 100) of the tenant's resources (`admin.read`). */
    listResources(ctx: AdminCallContext): Promise<ResourcePage> {
      return call(ctx, {
        method: "GET",
        route: "/admin/resources",
        path: "/admin/resources?limit=100",
        schema: ResourcePageSchema,
      });
    },
    updateClient(ctx: AdminCallContext, clientId: string, patch: ClientPatch): Promise<AdminClient> {
      return call(ctx, {
        method: "PATCH",
        route: "/admin/clients/:clientId",
        path: clientPath(clientId),
        body: patch,
        schema: AdminClientSchema,
      });
    },
  };
}

export type AdminApi = ReturnType<typeof createAdminApi>;
