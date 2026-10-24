import "@tanstack/react-start/server-only";
import { z } from "@/lib/zod";
import type { AdminApiErrorCode, AdminApiFailure, BackendHealth } from "@/features/admin-api/types";
import type {
  AuditListParams,
  CreateClientParams,
  CreateResourceParams,
  ListClientsParams,
  PageParams,
  RotateKeyParams,
  UpdateResourceParams,
  UserListParams,
  UserPageParams,
} from "@/features/admin-api/inputs";
import type { Auth } from "../auth/bff";
import { PublicError, logServerError } from "../errors";
import { fetchWithTimeout, type FetchFn } from "../oidc/discovery";
import type { components } from "./schema";
import {
  AdminClientSchema,
  AdminResourceSchema,
  ClientPageSchema,
  CredentialListSchema,
  IssuedSecretSchema,
  ResourcePageSchema,
  AdminUserSchema,
  AuditPageSchema,
  ConsentPageSchema,
  FamilyPageSchema,
  UserPageSchema,
  RotateKeyResultSchema,
  SigningKeyListSchema,
  type AdminClient,
  type AdminResource,
  type ClientPage,
  type CredentialList,
  type IssuedSecret,
  type ResourcePage,
  type AdminUser,
  type AuditPage,
  type ConsentPage,
  type FamilyPage,
  type UserPage,
  type RotateKeyResult,
  type SigningKeyList,
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

type Method = "GET" | "POST" | "PATCH" | "DELETE";
interface Operation<T> {
  method: Method;
  /** Route template for logs (never the concrete id). */
  route: string;
  path: string;
  body?: unknown;
  /** `null`: the success answer is `204 No Content` (nothing to parse). */
  schema: z.ZodType<T> | null;
}

export interface AdminApiDeps {
  baseUrl: string;
  fetch: FetchFn;
  auth: Pick<Auth, "accessToken" | "refreshRejected" | "dropSession">;
  timeoutMs?: number;
}

const DESCRIPTION_MAX = 200;

/** BE `/ready` body: only `status` is read (the dependency names never leave this module). */
const ReadySchema = z.object({ status: z.enum(["ok", "error"]) });
const READY_TIMEOUT_MS = 3000;

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
      if (op.schema === null) {
        if (status === 204) return undefined as T;
        throw unavailable(op, new Error(`HTTP ${status}: expected 204`), mutation);
      }
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

  const secretsPath = (clientId: string) => `${clientPath(clientId)}/secrets`;

  const resourcePath = (resourceId: string) => `/admin/resources/${encodeURIComponent(resourceId)}`;

  /** `?k=v&…` (encoded) of every defined value of a flat params object, or "" when none is. */
  const query = (params: Record<string, string | number | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
    return q.size ? `?${q}` : "";
  };

  const userPath = (userId: string) => `/admin/users/${encodeURIComponent(userId)}`;

  /** A user write without a body: `POST /admin/users/{id}/{action}` answering the user view. */
  const userAction = (ctx: AdminCallContext, userId: string, action: "lock" | "unlock"): Promise<AdminUser> =>
    call(ctx, {
      method: "POST",
      route: `/admin/users/:id/${action}`,
      path: `${userPath(userId)}/${action}`,
      schema: AdminUserSchema,
    });

  /** One page of the (global) resources, `identifier` ascending (`admin.read`). */
  function listResourcePage(ctx: AdminCallContext, params: PageParams): Promise<ResourcePage> {
    return call(ctx, {
      method: "GET",
      route: "/admin/resources",
      path: `/admin/resources${query(params)}`,
      schema: ResourcePageSchema,
    });
  }

  /**
   * BE readiness (`GET /ready`, public) for a signed-in admin only: no session => `unauthenticated`
   * and no request (this BFF is not a probe for anonymous callers). No bearer (the endpoint is
   * public), no retry, 3 s. Fail-closed: anything but a well-formed 200 `ok` / 503 `error` is
   * `unknown` (never "up" when unsure); the log has the route only, never the body.
   */
  async function readiness(ctx: AdminCallContext): Promise<BackendHealth> {
    const at = await deps.auth.accessToken(ctx.request);
    if (at.setCookie) ctx.setCookie(at.setCookie);
    if (!at.session) throw new AdminApiError("unauthenticated");
    try {
      const res = await fetchWithTimeout(
        deps.fetch,
        `${base}/ready`,
        { method: "GET", headers: { accept: "application/json" } },
        READY_TIMEOUT_MS,
      );
      const body = ReadySchema.safeParse(await res.json().catch(() => undefined));
      if (res.status === 200 && body.success && body.data.status === "ok") return "up";
      if (res.status === 503 && body.success && body.data.status === "error") return "down";
      throw new Error(`HTTP ${res.status}: unexpected readiness answer`);
    } catch (err) {
      logServerError("admin api GET /ready", err);
      return "unknown";
    }
  }

  return {
    readiness,
    listClients(ctx: AdminCallContext, params: ListClientsParams): Promise<ClientPage> {
      return call(ctx, { method: "GET", route: "/admin/clients", path: `/admin/clients${query(params)}`, schema: ClientPageSchema });
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
    /** First page (≤ 100) of the resources: the options of the client form. */
    listResources(ctx: AdminCallContext): Promise<ResourcePage> {
      return listResourcePage(ctx, { limit: 100 });
    },
    listResourcePage,
    getResource(ctx: AdminCallContext, resourceId: string): Promise<AdminResource> {
      return call(ctx, {
        method: "GET",
        route: "/admin/resources/:resourceId",
        path: resourcePath(resourceId),
        schema: AdminResourceSchema,
      });
    },
    /** `POST /admin/resources` (super_admin + recent sign-in; not idempotent: never re-sent). */
    createResource(ctx: AdminCallContext, body: CreateResourceParams): Promise<AdminResource> {
      return call(ctx, { method: "POST", route: "/admin/resources", path: "/admin/resources", body, schema: AdminResourceSchema });
    },
    /** `PATCH /admin/resources/{id}`: replaces `scopes` (the only mutable field). */
    updateResource(ctx: AdminCallContext, resourceId: string, patch: UpdateResourceParams["patch"]): Promise<AdminResource> {
      return call(ctx, {
        method: "PATCH",
        route: "/admin/resources/:resourceId",
        path: resourcePath(resourceId),
        body: patch,
        schema: AdminResourceSchema,
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
    /** Secret versions of a client: metadata only (no hash, no secret). */
    listSecrets(ctx: AdminCallContext, clientId: string): Promise<CredentialList> {
      return call(ctx, {
        method: "GET",
        route: "/admin/clients/:clientId/secrets",
        path: secretsPath(clientId),
        schema: CredentialListSchema,
      });
    },
    /**
     * Issue (= rotate) a secret: the plaintext is in this answer only. Not idempotent: never re-sent;
     * a timeout/5xx/off-contract 2xx is `uncertain` and nothing of the body is logged.
     */
    issueSecret(ctx: AdminCallContext, clientId: string): Promise<IssuedSecret> {
      return call(ctx, {
        method: "POST",
        route: "/admin/clients/:clientId/secrets",
        path: secretsPath(clientId),
        schema: IssuedSecretSchema,
      });
    },
    /** Revoke one version now (no grace): `204`; an unknown/already revoked version is `not_found`. */
    revokeSecret(ctx: AdminCallContext, clientId: string, version: number): Promise<void> {
      return call(ctx, {
        method: "DELETE",
        route: "/admin/clients/:clientId/secrets/:version",
        path: `${secretsPath(clientId)}/${String(version)}`,
        schema: null,
      });
    },
    /**
     * Users of the token's tenant (`admin.read`). `email` (exact) is in this BE query only: the
     * logged route is the template, never the query (the BE log strips it too).
     */
    listUsers(ctx: AdminCallContext, params: UserListParams): Promise<UserPage> {
      return call(ctx, { method: "GET", route: "/admin/users", path: `/admin/users${query(params)}`, schema: UserPageSchema });
    },
    getUser(ctx: AdminCallContext, userId: string): Promise<AdminUser> {
      return call(ctx, { method: "GET", route: "/admin/users/:id", path: userPath(userId), schema: AdminUserSchema });
    },
    /** Locks until unlocked (global), then ends every session/family: a 5xx may follow an applied lock. */
    lockUser: (ctx: AdminCallContext, userId: string) => userAction(ctx, userId, "lock"),
    /** Clears the lock and the failed-login counter; restores nothing. */
    unlockUser: (ctx: AdminCallContext, userId: string) => userAction(ctx, userId, "unlock"),
    /** Ends every IdP session and refresh family of the user, in every tenant (`204`, idempotent). */
    revokeUserSessions(ctx: AdminCallContext, userId: string): Promise<void> {
      return call(ctx, {
        method: "POST",
        route: "/admin/users/:id/sessions/revoke",
        path: `${userPath(userId)}/sessions/revoke`,
        schema: null,
      });
    },
    listUserFamilies(ctx: AdminCallContext, params: UserPageParams): Promise<FamilyPage> {
      return call(ctx, {
        method: "GET",
        route: "/admin/users/:id/families",
        path: `${userPath(params.userId)}/families${query({ limit: params.limit, after: params.after })}`,
        schema: FamilyPageSchema,
      });
    },
    /** `204`, idempotent (an already revoked family is still `204`). */
    revokeUserFamily(ctx: AdminCallContext, userId: string, familyId: string): Promise<void> {
      return call(ctx, {
        method: "POST",
        route: "/admin/users/:id/families/:familyId/revoke",
        path: `${userPath(userId)}/families/${encodeURIComponent(familyId)}/revoke`,
        schema: null,
      });
    },
    listUserConsents(ctx: AdminCallContext, params: UserPageParams): Promise<ConsentPage> {
      return call(ctx, {
        method: "GET",
        route: "/admin/users/:id/consents",
        path: `${userPath(params.userId)}/consents${query({ limit: params.limit, after: params.after })}`,
        schema: ConsentPageSchema,
      });
    },
    /** `204`; an already revoked consent is `not_found` (not idempotent: never re-sent). */
    revokeUserConsent(ctx: AdminCallContext, userId: string, consentId: string): Promise<void> {
      return call(ctx, {
        method: "DELETE",
        route: "/admin/users/:id/consents/:consentId",
        path: `${userPath(userId)}/consents/${encodeURIComponent(consentId)}`,
        schema: null,
      });
    },
    /**
     * Audit events of the token's tenant (`admin.read`), newest first. Filters are enums, opaque ids
     * and ISO times only (never an email); the logged route is the template, never the query.
     */
    listAudit(ctx: AdminCallContext, params: AuditListParams): Promise<AuditPage> {
      return call(ctx, { method: "GET", route: "/admin/audit", path: `/admin/audit${query(params)}`, schema: AuditPageSchema });
    },
    /** Signing keys in the JWKS (super_admin): metadata only, never key material. */
    listSigningKeys(ctx: AdminCallContext): Promise<SigningKeyList> {
      return call(ctx, { method: "GET", route: "/admin/keys", path: "/admin/keys", schema: SigningKeyListSchema });
    },
    /**
     * `POST /admin/keys/rotate` (super_admin + recent sign-in). Not idempotent: never re-sent;
     * timeout/5xx/off-contract 2xx => uncertain (it may have rotated).
     */
    rotateSigningKey(ctx: AdminCallContext, mode: RotateKeyParams["mode"]): Promise<RotateKeyResult> {
      return call(ctx, {
        method: "POST",
        route: "/admin/keys/rotate",
        path: "/admin/keys/rotate",
        body: { mode },
        schema: RotateKeyResultSchema,
      });
    },
  };
}

export type AdminApi = ReturnType<typeof createAdminApi>;
