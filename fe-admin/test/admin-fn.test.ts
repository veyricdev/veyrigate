// @vitest-environment node
// Admin server functions (run 43 F2): input validated by zod before any admin API call (no path
// traversal, no unknown field), and `adminCall` returns a typed failure as a value.
import { beforeEach, describe, expect, it, vi } from "vitest";

const responseHeaders = new Headers();
const adminCallSpy = vi.fn(async (fn: (api: unknown, ctx: unknown) => Promise<unknown>) => ({ ok: true, data: await fn(fakeApi, {}) }));
const fakeApi = {
  listClients: vi.fn(async () => "list"),
  getClient: vi.fn(async () => "one"),
  updateClient: vi.fn(async () => "updated"),
};

// createServerFn(...).inputValidator(schema).handler(fn): run the validator like Start does.
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    inputValidator: (schema: { parse: (v: unknown) => unknown }) => ({
      handler: (fn: (o: { data: unknown }) => unknown) => async (o: { data: unknown }) =>
        fn({ data: schema.parse(o.data) }),
    }),
  }),
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("http://localhost:3000/clients"),
  getResponseHeaders: () => responseHeaders,
}));

type Fn = (o: { data: unknown }) => Promise<unknown>;

describe("server functions", () => {
  let fns: Record<"listClients" | "getClient" | "updateClient", Fn>;
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("@/server/admin-api/instance", () => ({ adminCall: adminCallSpy }));
    fns = (await import("@/features/admin-api/clients")) as never;
    adminCallSpy.mockClear();
    for (const f of Object.values(fakeApi)) f.mockClear();
  });

  it.each(["../x", "a/b", "a\\b", ".", "..", "", "x".repeat(129)])("getClient(%j) => rejected, API never called", async (id) => {
    await expect(fns.getClient({ data: id })).rejects.toThrow();
    expect(adminCallSpy).not.toHaveBeenCalled();
  });

  it("updateClient with an unknown field or a bad client id => rejected before the API", async () => {
    await expect(fns.updateClient({ data: { clientId: "app-1", patch: { clientSecret: "s" } } })).rejects.toThrow();
    await expect(fns.updateClient({ data: { clientId: "../app", patch: {} } })).rejects.toThrow();
    await expect(fns.updateClient({ data: { clientId: "app-1", patch: { tenantId: "t2" } } })).rejects.toThrow();
    expect(adminCallSpy).not.toHaveBeenCalled();
  });

  it("valid input reaches exactly its own endpoint method", async () => {
    expect(await fns.getClient({ data: "app-1" })).toEqual({ ok: true, data: "one" });
    expect(fakeApi.getClient).toHaveBeenCalledWith({}, "app-1");
    const patch = { redirectUris: ["https://app.example/cb"] };
    expect(await fns.updateClient({ data: { clientId: "app-1", patch } })).toEqual({ ok: true, data: "updated" });
    expect(fakeApi.updateClient).toHaveBeenCalledWith({}, "app-1", patch);
    await fns.listClients({ data: { limit: 10 } });
    expect(fakeApi.listClients).toHaveBeenCalledWith({}, { limit: 10 });
    await expect(fns.listClients({ data: { limit: 1000 } })).rejects.toThrow();
  });
});

describe("adminCall", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@/server/admin-api/instance");
    vi.doMock("@/server/env", () => ({ serverEnv: () => ({ ADMIN_API_BASE_URL: "http://idp.test" }) }));
    vi.doMock("@/server/auth/instance", () => ({ getAuth: () => ({}) }));
  });

  it("typed failure => { ok:false, error } value; cookie appended; other errors rethrown", async () => {
    const { adminCall } = await import("@/server/admin-api/instance");
    const { AdminApiError } = await import("@/server/admin-api/client");
    responseHeaders.append("set-cookie", "fea_theme=dark; Path=/");
    const res = await adminCall(async (_api, ctx) => {
      ctx.setCookie("fea_sid=; Path=/; Max-Age=0");
      throw new AdminApiError("step_up_required");
    });
    expect(res).toEqual({
      ok: false,
      error: { code: "step_up_required", message: "Please confirm your identity to continue." },
    });
    expect(responseHeaders.getSetCookie()).toEqual(["fea_theme=dark; Path=/", "fea_sid=; Path=/; Max-Age=0"]);
    const boom = new Error("x");
    await expect(
      adminCall(async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});
