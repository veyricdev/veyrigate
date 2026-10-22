// @vitest-environment node
// Admin API client (run 43 F2) against the fake IdP + fake admin API (injected fetch, error bodies
// copied from be/src/modules/identity/tenant-context/admin-auth.errors.ts) and the real test Redis.
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminApiError, createAdminApi, type AdminApi } from "@/server/admin-api/client";
import { ServiceUnavailableError } from "@/server/errors";
import { connectTestRedis } from "./support/redis";
import { APP_URL, ISSUER, createFakeIdp, signIn, type AdminReply, type FakeIdp } from "./support/fake-idp";

let redis: Redis;
let idp: FakeIdp;
let api: AdminApi;
let logged: string[];

beforeAll(async () => {
  redis = await connectTestRedis();
});
beforeEach(async () => {
  idp = await createFakeIdp(redis);
  api = createAdminApi({ baseUrl: `${ISSUER}/`, fetch: idp.fetch, auth: idp.auth, timeoutMs: 100 });
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...a) => void logged.push(a.map(String).join(" ")));
  vi.spyOn(console, "warn").mockImplementation((...a) => void logged.push(a.map(String).join(" ")));
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (idp.sessionKeys.size) await redis.del(...idp.sessionKeys);
});
afterAll(() => redis.disconnect());

const BE_CLIENT = {
  clientId: "app-1",
  tenantId: "t1",
  clientType: "confidential",
  tokenEndpointAuthMethod: "client_secret_basic",
  grantTypes: ["authorization_code"],
  redirectUris: ["https://app.example/cb"],
  postLogoutRedirectUris: [],
  frontchannelLogoutUri: null,
  allowedCorsOrigins: [],
  allowedResources: [],
  scopes: ["openid"],
  disabled: false,
  disabledAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: null,
};

/** A signed-in request context; `cookies` collects what the BFF would Set-Cookie. */
async function session() {
  const { sid } = await signIn(idp);
  const key = idp.store.keyFor(sid);
  const stored = await idp.store.get(key);
  if (stored.status !== "ok") throw new Error("no session");
  const cookies: string[] = [];
  const ctx = {
    request: new Request(`${APP_URL}/clients`, { headers: { cookie: `fea_sid=${sid}` } }),
    setCookie: (c: string) => void cookies.push(c),
  };
  return { sid, key, ctx, cookies, at: stored.data.tokens.accessToken, rt: stored.data.tokens.refreshToken };
}

const refreshGrants = () => idp.calls.token.filter((f) => f.get("grant_type") === "refresh_token");
const failure = (p: Promise<unknown>) => p.then(
  () => {
    throw new Error("expected a failure");
  },
  (e: unknown) => e,
);
const reply = (r: AdminReply) => {
  idp.adminApi = () => r;
};

describe("success", () => {
  it("GET list: bearer AT, fixed path + query, response allowlisted (unknown field stripped)", async () => {
    const s = await session();
    reply({ status: 200, body: { items: [{ ...BE_CLIENT, secretHash: "h" }], nextCursor: null, debug: 1 } });
    const page = await api.listClients(s.ctx, { limit: 5, after: "a&b" });
    expect(page).toEqual({ items: [BE_CLIENT], nextCursor: null });
    expect(JSON.stringify(page)).not.toContain("secretHash");
    const [call] = idp.calls.admin;
    expect(call!.method).toBe("GET");
    expect(call!.url.pathname + call!.url.search).toBe("/admin/clients?limit=5&after=a%26b");
    expect(call!.headers.get("authorization")).toBe(`Bearer ${s.at}`);
  });

  it("path id is URI-encoded; PATCH sends the JSON body once", async () => {
    const s = await session();
    reply({ status: 200, body: BE_CLIENT });
    await api.updateClient(s.ctx, "a b?c", { redirectUris: ["https://app.example/cb2"] });
    const [call] = idp.calls.admin;
    expect(call!.url.pathname).toBe("/admin/clients/a%20b%3Fc");
    expect(call!.url.search).toBe("");
    expect(call!.method).toBe("PATCH");
    expect(call!.body).toEqual({ redirectUris: ["https://app.example/cb2"] });
    expect(call!.headers.get("content-type")).toBe("application/json");
  });
});

describe("error mapping (BE wire shape => code)", () => {
  it.each([
    ["403 step_up_required", { status: 403, body: { error: "step_up_required", max_age: 0 } }, "step_up_required"],
    ["403 forbidden", { status: 403, body: { error: "forbidden" } }, "forbidden"],
    ["403 insufficient_scope", { status: 403, body: { error: "insufficient_scope" } }, "forbidden"],
    ["404 not_found", { status: 404, body: { error: "not_found" } }, "not_found"],
  ] as const)("%s => %s, fixed message, no refresh", async (_, r, code) => {
    const s = await session();
    reply(r);
    const err = (await failure(api.getClient(s.ctx, "app-1"))) as AdminApiError;
    expect(err).toBeInstanceOf(AdminApiError);
    expect(err.code).toBe(code);
    expect(err.uncertain).toBeUndefined();
    expect(err.message).not.toMatch(/step_up_required|forbidden|insufficient_scope|not_found/);
    expect(refreshGrants()).toHaveLength(0);
    expect(idp.calls.admin).toHaveLength(1);
    expect(s.cookies).toEqual([]);
  });

  it.each([
    [400, "invalid_request"],
    [409, "conflict"],
  ] as const)("%i %s => the BE description, cut to 200 chars", async (status, error) => {
    const s = await session();
    reply({ status, body: { error, error_description: `<b>${"x".repeat(300)}` } });
    const err = (await failure(api.updateClient(s.ctx, "app-1", { scopes: ["openid"] }))) as AdminApiError;
    expect(err.code).toBe(error);
    expect(err.message).toBe(`<b>${"x".repeat(197)}`);
  });

  it("400 without a description => fixed message", async () => {
    const s = await session();
    reply({ status: 400, body: { error: "invalid_request" } });
    const err = (await failure(api.updateClient(s.ctx, "app-1", {}))) as AdminApiError;
    expect(err.code).toBe("invalid_request");
    expect(err.message).toBe("The request was rejected.");
  });

  it.each([
    ["GET 500", "GET", { status: 500, body: { error: "server_error" } }, false],
    ["GET 502", "GET", { status: 502, raw: "bad gateway" }, false],
    ["PATCH 500", "PATCH", { status: 500, body: { error: "server_error" } }, true],
    ["PATCH 503", "PATCH", { status: 503, raw: "" }, true],
    ["GET 302", "GET", { status: 302, raw: "" }, false],
    ["GET 200 non-JSON", "GET", { status: 200, raw: "<html>" }, false],
    ["PATCH 403 non-JSON", "PATCH", { status: 403, raw: "<html>" }, false],
    ["GET network error", "GET", "network-error", false],
    ["PATCH network error", "PATCH", "network-error", true],
  ] as const)("%s => unavailable (uncertain: %s), sent once", async (_, method, r, uncertain) => {
    const s = await session();
    reply(r);
    const p = method === "GET" ? api.getClient(s.ctx, "app-1") : api.updateClient(s.ctx, "app-1", { scopes: [] });
    const err = (await failure(p)) as AdminApiError;
    expect(err).toBeInstanceOf(AdminApiError);
    expect(err.code).toBe("unavailable");
    expect(err.status).toBe(503);
    expect(err.uncertain === true).toBe(uncertain);
    expect(idp.calls.admin).toHaveLength(1);
    expect(logged.join("\n")).toMatch(new RegExp(`admin api ${method} /admin/clients/:clientId failed`));
  });

  it("mutation timeout => unavailable + uncertain, fetch called exactly once", async () => {
    const s = await session();
    reply("hang");
    const err = (await failure(api.updateClient(s.ctx, "app-1", { scopes: [] }))) as AdminApiError;
    expect(err.code).toBe("unavailable");
    expect(err.uncertain).toBe(true);
    expect(idp.calls.admin).toHaveLength(1);
  });

  it("any other status (418) => plain Error (generic 500 at the boundary), not a typed failure", async () => {
    const s = await session();
    reply({ status: 418, body: { error: "teapot", error_description: "secret detail" } });
    const err = (await failure(api.getClient(s.ctx, "app-1"))) as Error;
    expect(err).not.toBeInstanceOf(AdminApiError);
    expect(err.message).toBe("admin api GET /admin/clients/:clientId: HTTP 418");
  });

  it("response off-schema => plain Error (500), not unavailable", async () => {
    const s = await session();
    reply({ status: 200, body: { ...BE_CLIENT, redirectUris: "not-an-array" } });
    const err = (await failure(api.getClient(s.ctx, "app-1"))) as Error;
    expect(err).not.toBeInstanceOf(AdminApiError);
    expect(err.message).toMatch(/response schema mismatch/);
  });
});

describe("401 => one forced refresh, one retry", () => {
  const rejectToken = (token: string) => {
    idp.adminApi = (r) =>
      r.headers.get("authorization") === `Bearer ${token}`
        ? { status: 401, body: { error: "invalid_token" } }
        : { status: 200, body: BE_CLIENT };
  };

  it("401 -> refresh -> OK (also for a mutation: the guard refused before the handler ran)", async () => {
    const s = await session();
    rejectToken(s.at);
    expect(await api.updateClient(s.ctx, "app-1", { scopes: ["openid"] })).toEqual(BE_CLIENT);
    expect(refreshGrants()).toHaveLength(1);
    expect(refreshGrants()[0]!.get("refresh_token")).toBe(s.rt);
    expect(idp.calls.admin).toHaveLength(2);
    const stored = await idp.store.get(s.key);
    const newAt = stored.status === "ok" ? stored.data.tokens.accessToken : "";
    expect(newAt).not.toBe(s.at);
    expect(idp.calls.admin[1]!.headers.get("authorization")).toBe(`Bearer ${newAt}`);
    expect(s.cookies).toEqual([]);
  });

  it("401 -> refresh invalid_grant => unauthenticated, session gone, cookie cleared, no retry", async () => {
    const s = await session();
    rejectToken(s.at);
    idp.token = () => ({ status: 400, body: { error: "invalid_grant" } });
    const err = (await failure(api.getClient(s.ctx, "app-1"))) as AdminApiError;
    expect(err.code).toBe("unauthenticated");
    expect(err.status).toBe(401);
    expect(await redis.exists(s.key)).toBe(0);
    expect(s.cookies).toEqual([expect.stringMatching(/^fea_sid=; .*Max-Age=0/)]);
    expect(idp.calls.admin).toHaveLength(1);
  });

  it("401 twice => unauthenticated, session destroyed, RT revoked, cookie cleared", async () => {
    const s = await session();
    idp.adminApi = () => ({ status: 401, body: { error: "invalid_token" } });
    const err = (await failure(api.getClient(s.ctx, "app-1"))) as AdminApiError;
    expect(err.code).toBe("unauthenticated");
    expect(refreshGrants()).toHaveLength(1);
    expect(idp.calls.admin).toHaveLength(2);
    expect(await redis.exists(s.key)).toBe(0);
    expect(idp.calls.revoke).toHaveLength(1);
    expect(idp.calls.revoke[0]).not.toBe(s.rt); // the rotated RT is the live one
    expect(s.cookies).toEqual([expect.stringMatching(/^fea_sid=; .*Max-Age=0/)]);
  });

  it("two parallel 401s => exactly ONE refresh grant (RT single-use), both succeed", async () => {
    const s = await session();
    rejectToken(s.at);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = idp.token;
    idp.token = async (r) => {
      await gate;
      return original(r);
    };
    const both = Promise.all([api.getClient(s.ctx, "app-1"), api.getClient(s.ctx, "app-2")]);
    await new Promise((r) => setTimeout(r, 50));
    release();
    expect(await both).toEqual([BE_CLIENT, BE_CLIENT]);
    expect(refreshGrants()).toHaveLength(1);
    // Both retried with the same new AT.
    const retried = idp.calls.admin.slice(2).map((c) => c.headers.get("authorization"));
    expect(retried).toHaveLength(2);
    expect(new Set(retried).size).toBe(1);
    expect(retried[0]).not.toBe(`Bearer ${s.at}`);
  });

  it("refresh IdP down => ServiceUnavailableError (503), session kept", async () => {
    const s = await session();
    rejectToken(s.at);
    idp.token = () => ({ status: 503, body: { error: "temporarily_unavailable" } });
    await expect(api.getClient(s.ctx, "app-1")).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(await redis.exists(s.key)).toBe(1);
  });
});

describe("no session", () => {
  it("no cookie => unauthenticated, the admin API is never called", async () => {
    const ctx = { request: new Request(`${APP_URL}/clients`), setCookie: vi.fn() };
    const err = (await failure(api.listClients(ctx, {}))) as AdminApiError;
    expect(err.code).toBe("unauthenticated");
    expect(idp.calls.admin).toHaveLength(0);
    expect(ctx.setCookie).not.toHaveBeenCalled();
  });

  it("unknown session cookie => unauthenticated + cookie cleared, no call", async () => {
    const cookies: string[] = [];
    const ctx = {
      request: new Request(`${APP_URL}/clients`, { headers: { cookie: "fea_sid=forged" } }),
      setCookie: (c: string) => void cookies.push(c),
    };
    const err = (await failure(api.listClients(ctx, {}))) as AdminApiError;
    expect(err.code).toBe("unauthenticated");
    expect(cookies).toEqual([expect.stringMatching(/Max-Age=0/)]);
    expect(idp.calls.admin).toHaveLength(0);
  });
});

describe("what crosses to the browser", () => {
  it("serialised failure = code + message (+ uncertain) only; no AT/RT/header/body in it or in the logs", async () => {
    const s = await session();
    idp.adminApi = () => ({ status: 500, body: { error: "server_error", error_description: `leak ${s.at}` } });
    const err = (await failure(api.updateClient(s.ctx, "app-1", { scopes: [] }))) as AdminApiError;
    const wire = JSON.parse(JSON.stringify(err.toFailure())) as Record<string, unknown>;
    expect(Object.keys(wire).sort()).toEqual(["code", "message", "uncertain"]);
    expect(wire).toEqual({
      code: "unavailable",
      message: "The admin service is temporarily unavailable. Please try again.",
      uncertain: true,
    });
    const own = JSON.stringify(Object.fromEntries(Object.keys(err).map((k) => [k, (err as never)[k]])));
    for (const text of [JSON.stringify(wire), own, err.message, logged.join("\n")]) {
      expect(text).not.toContain(s.at);
      expect(text).not.toContain(s.rt);
      expect(text).not.toMatch(/Bearer|WWW-Authenticate|leak/i);
    }
  });

  it("401 path logs never carry a token either", async () => {
    const s = await session();
    idp.adminApi = () => ({ status: 401, body: { error: "invalid_token" } });
    await failure(api.getClient(s.ctx, "app-1"));
    expect(logged.join("\n")).not.toContain(s.at);
    expect(logged.join("\n")).not.toMatch(/at-[0-9a-f]{16}|rt-[0-9a-f]{16}/);
  });
});
