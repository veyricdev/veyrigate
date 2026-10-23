// @vitest-environment node
// Run 46 F2: the resource server functions through the REAL `adminCall` + admin API client (only
// the BE fetch, the session and Start's request/response are faked): fixed endpoints, error codes,
// `uncertain` for writes only, input validators (path id, strict PATCH body) before any BE call.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const beFetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    inputValidator: (schema: { parse: (v: unknown) => unknown }) => ({
      handler: (fn: (o: { data: unknown }) => unknown) => async (o: { data: unknown }) =>
        fn({ data: schema.parse(o.data) }),
    }),
  }),
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("http://localhost:3000/resources"),
  getResponseHeaders: () => new Headers(),
}));
vi.mock("@/server/env", () => ({
  serverEnv: () => ({ ADMIN_API_BASE_URL: "http://idp.test", OIDC_ISSUER: "http://idp.test" }),
}));
vi.mock("@/server/auth/instance", () => ({
  getAuth: () => ({
    accessToken: async () => ({ session: { key: "k", token: "at" } }),
    refreshRejected: async () => null,
    dropSession: async () => "fea_sid=; Max-Age=0",
  }),
}));

type Fn = (o: { data: unknown }) => Promise<unknown>;
let fns: { listResourcePage: Fn; getResource: Fn; createResource: Fn; updateResource: Fn };
let logged: string[];

beforeEach(async () => {
  beFetch.mockReset();
  vi.stubGlobal("fetch", beFetch);
  logged = [];
  for (const level of ["error", "warn", "log", "info", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...a) => void logged.push(a.map(String).join(" ")));
  }
  fns = (await import("@/features/admin-api/resources")) as never;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const R = { resourceId: "demo", identifier: "https://api.example.com/", scopes: ["read"] };
const NEW = { resourceId: "demo", identifier: "https://api.example.com/", scopes: ["read"] };
const PATCH = { resourceId: "demo", patch: { scopes: ["read", "write"] } };
const call = (i = 0) => {
  const [url, init] = beFetch.mock.calls[i]!;
  return { url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) };
};

describe("endpoints", () => {
  it("list: GET /admin/resources with limit + encoded after; items allowlisted", async () => {
    beFetch.mockResolvedValue(json(200, { items: [{ ...R, tenantId: "t1" }], nextCursor: "https://b/" }));
    expect(await fns.listResourcePage({ data: { limit: 20, after: "https://a/?x=1&y" } })).toEqual({
      ok: true,
      data: { items: [R], nextCursor: "https://b/" },
    });
    const c = call();
    expect(c.method).toBe("GET");
    expect(c.url).toBe("http://idp.test/admin/resources?limit=20&after=https%3A%2F%2Fa%2F%3Fx%3D1%26y");
  });

  it("list without params: no query string", async () => {
    beFetch.mockResolvedValue(json(200, { items: [], nextCursor: null }));
    await fns.listResourcePage({ data: {} });
    expect(call().url).toBe("http://idp.test/admin/resources");
  });

  it("get: GET /admin/resources/{id}, id URI-encoded", async () => {
    beFetch.mockResolvedValue(json(200, R));
    expect(await fns.getResource({ data: "a b?c" })).toEqual({ ok: true, data: R });
    expect(call()).toMatchObject({ method: "GET", url: "http://idp.test/admin/resources/a%20b%3Fc" });
  });

  it("create: POST /admin/resources once with the body", async () => {
    beFetch.mockResolvedValue(json(201, R));
    expect(await fns.createResource({ data: NEW })).toEqual({ ok: true, data: R });
    expect(beFetch).toHaveBeenCalledTimes(1);
    expect(call()).toEqual({ method: "POST", url: "http://idp.test/admin/resources", body: NEW });
  });

  it("update: PATCH /admin/resources/{id} with exactly { scopes }", async () => {
    beFetch.mockResolvedValue(json(200, { ...R, scopes: ["read", "write"] }));
    await fns.updateResource({ data: PATCH });
    expect(call()).toEqual({ method: "PATCH", url: "http://idp.test/admin/resources/demo", body: { scopes: ["read", "write"] } });
    expect(Object.keys(call().body)).toEqual(["scopes"]);
  });

  it("update with [] is valid (replaces the list)", async () => {
    beFetch.mockResolvedValue(json(200, { ...R, scopes: [] }));
    await fns.updateResource({ data: { resourceId: "demo", patch: { scopes: [] } } });
    expect(call().body).toEqual({ scopes: [] });
  });
});

describe("error codes (BE wire shape)", () => {
  it.each([
    [400, { error: "invalid_request", error_description: "resource must not contain a fragment: https://a/#x" }, "invalid_request"],
    [403, { error: "forbidden" }, "forbidden"],
    [403, { error: "step_up_required", max_age: 0 }, "step_up_required"],
    [404, { error: "not_found" }, "not_found"],
    [409, { error: "conflict", error_description: "Resource already exists" }, "conflict"],
  ] as const)("%i %j => %s (create, update, get)", async (status, body, code) => {
    for (const [fn, data] of [
      [fns.createResource, NEW],
      [fns.updateResource, PATCH],
      [fns.getResource, "demo"],
    ] as const) {
      beFetch.mockResolvedValueOnce(json(status, body));
      const result = (await fn({ data })) as { ok: false; error: { code: string; uncertain?: true; message: string } };
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe(code);
      expect(result.error.uncertain).toBeUndefined();
    }
  });

  it("409 keeps the BE description as text", async () => {
    beFetch.mockResolvedValue(json(409, { error: "conflict", error_description: "Resource already exists" }));
    expect(await fns.createResource({ data: NEW })).toEqual({
      ok: false,
      error: { code: "conflict", message: "Resource already exists" },
    });
  });
});

describe("uncertain: writes only", () => {
  it.each([
    ["2xx off schema", () => Promise.resolve(json(201, { resourceId: "demo" }))],
    ["2xx not JSON", () => Promise.resolve(new Response("x", { status: 200 }))],
    ["5xx", () => Promise.resolve(json(502, {}))],
    ["network / timeout", () => Promise.reject(new TypeError("fetch failed"))],
  ])("%s => unavailable + uncertain for create and update, sent once", async (_, res) => {
    for (const [fn, data] of [
      [fns.createResource, NEW],
      [fns.updateResource, PATCH],
    ] as const) {
      beFetch.mockReset();
      beFetch.mockImplementation(res);
      expect(await fn({ data })).toEqual({
        ok: false,
        error: { code: "unavailable", message: expect.any(String), uncertain: true },
      });
      expect(beFetch).toHaveBeenCalledTimes(1);
    }
  });

  it("GET 5xx => unavailable, NOT uncertain", async () => {
    beFetch.mockResolvedValue(json(503, {}));
    expect(await fns.getResource({ data: "demo" })).toEqual({ ok: false, error: { code: "unavailable", message: expect.any(String) } });
    beFetch.mockResolvedValue(json(503, {}));
    expect(await fns.listResourcePage({ data: {} })).toEqual({ ok: false, error: { code: "unavailable", message: expect.any(String) } });
  });

  it("a BE error body is never logged", async () => {
    beFetch.mockResolvedValue(json(502, { identifier: "canary-body-123" }));
    await fns.createResource({ data: NEW });
    expect(logged.join("\n")).not.toContain("canary-body-123");
    expect(logged.join("\n")).toContain("/admin/resources");
  });
});

describe("input validators (before the BE)", () => {
  it.each(["../x", "a/b", "a\\b", ".", "..", "", "x".repeat(129), 1, null])("getResource(%j) refused", async (id) => {
    await expect(fns.getResource({ data: id })).rejects.toThrow();
    expect(beFetch).not.toHaveBeenCalled();
  });

  it("path id outside the create regex (seeded / older) is still accepted", async () => {
    beFetch.mockResolvedValue(json(200, { ...R, resourceId: "Legacy_Res" }));
    await fns.getResource({ data: "Legacy_Res" });
    expect(call().url).toBe("http://idp.test/admin/resources/Legacy_Res");
  });

  it.each([
    ["identifier in patch", { resourceId: "demo", patch: { scopes: [], identifier: "https://x/" } }],
    ["resourceId in patch", { resourceId: "demo", patch: { scopes: [], resourceId: "other" } }],
    ["no scopes", { resourceId: "demo", patch: {} }],
    ["bad path id", { resourceId: "../demo", patch: { scopes: [] } }],
    ["scope with a space", { resourceId: "demo", patch: { scopes: ["a b"] } }],
    ["51 scopes", { resourceId: "demo", patch: { scopes: Array.from({ length: 51 }, (_, i) => `s${i}`) } }],
    ["257-char scope", { resourceId: "demo", patch: { scopes: ["s".repeat(257)] } }],
  ])("updateResource: %s => refused", async (_, data) => {
    await expect(fns.updateResource({ data })).rejects.toThrow();
    expect(beFetch).not.toHaveBeenCalled();
  });

  it("updateResource: 50 scopes of 256 chars accepted", async () => {
    beFetch.mockResolvedValue(json(200, R));
    const scopes = Array.from({ length: 50 }, (_, i) => `${i}`.padEnd(256, "s"));
    await fns.updateResource({ data: { resourceId: "demo", patch: { scopes } } });
    expect(call().body.scopes).toHaveLength(50);
  });

  it.each([
    ["uppercase id", { ...NEW, resourceId: "Demo" }],
    ["id starting with -", { ...NEW, resourceId: "-demo" }],
    ["id of 65 chars", { ...NEW, resourceId: "a".repeat(65) }],
    ["empty identifier", { ...NEW, identifier: "" }],
    ["2049-char identifier", { ...NEW, identifier: `https://a/${"x".repeat(2039)}` }],
    ["unknown field", { ...NEW, tenantId: "t1" }],
  ])("createResource: %s => refused", async (_, data) => {
    await expect(fns.createResource({ data })).rejects.toThrow();
    expect(beFetch).not.toHaveBeenCalled();
  });

  it("createResource: 64-char id accepted", async () => {
    beFetch.mockResolvedValue(json(201, R));
    await fns.createResource({ data: { ...NEW, resourceId: `a${"b.c_-".repeat(10)}abc` } });
    expect(beFetch).toHaveBeenCalledTimes(1);
  });

  it("listResourcePage: limit out of range refused", async () => {
    await expect(fns.listResourcePage({ data: { limit: 101 } })).rejects.toThrow();
    await expect(fns.listResourcePage({ data: { after: "" } })).rejects.toThrow();
    expect(beFetch).not.toHaveBeenCalled();
  });
});
