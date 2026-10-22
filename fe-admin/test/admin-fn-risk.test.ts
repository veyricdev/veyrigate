// @vitest-environment node
// Tester risk matrix for the admin server function inputs (run 43, tester): wrong types, unknown
// or prototype keys, oversized values never reach the admin API; boundary values do.
import { beforeEach, describe, expect, it, vi } from "vitest";

const adminCallSpy = vi.fn(async (fn: (api: unknown, ctx: unknown) => Promise<unknown>) => ({ ok: true, data: await fn(fakeApi, {}) }));
const fakeApi = {
  listClients: vi.fn(async () => "list"),
  getClient: vi.fn(async () => "one"),
  updateClient: vi.fn(async () => "updated"),
};

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    inputValidator: (schema: { parse: (v: unknown) => unknown }) => ({
      handler: (fn: (o: { data: unknown }) => unknown) => async (o: { data: unknown }) =>
        fn({ data: schema.parse(o.data) }),
    }),
    handler: (fn: () => unknown) => async () => fn(), // listResources: no input
  }),
}));
vi.mock("@/server/admin-api/instance", () => ({ adminCall: adminCallSpy }));

type Fn = (o: { data: unknown }) => Promise<unknown>;
let fns: Record<"listClients" | "getClient" | "updateClient", Fn>;

beforeEach(async () => {
  fns = (await import("@/features/admin-api/clients")) as never;
  adminCallSpy.mockClear();
  for (const f of Object.values(fakeApi)) f.mockClear();
});

const long = (n: number) => "h".repeat(n);

describe("updateClient patch: wrong type / unknown key / oversized => refused before the API", () => {
  it.each([
    ["redirectUris as string", { redirectUris: "https://evil.example/cb" }],
    ["redirectUris with a number", { redirectUris: [1] }],
    ["disabled as string", { disabled: "true" }],
    ["disabled as 1", { disabled: 1 }],
    ["grantTypes client_credentials", { grantTypes: ["client_credentials"] }],
    ["grantTypes implicit", { grantTypes: ["implicit"] }],
    ["21 redirect URIs", { redirectUris: Array.from({ length: 21 }, (_, i) => `https://a.example/${i}`) }],
    ["URI of 2049 chars", { redirectUris: [long(2049)] }],
    ["frontchannelLogoutUri as number", { frontchannelLogoutUri: 5 }],
    ["scopes as object", { scopes: { 0: "openid" } }],
    ["tenantId (cross-tenant move)", { tenantId: "t2" }],
    ["clientId rename", { clientId: "other" }],
    ["clientSecret", { clientSecret: "s" }],
    ["secretHash", { secretHash: "h" }],
    ["__proto__ own key (JSON)", JSON.parse('{"__proto__":{"isAdmin":true}}')],
    ["constructor key", { constructor: { prototype: { x: 1 } } }],
    ["nested unknown in array item", { redirectUris: [{ url: "x" }] }],
  ])("%s", async (_, patch) => {
    await expect(fns.updateClient({ data: { clientId: "app-1", patch } })).rejects.toThrow();
    expect(adminCallSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["patch null", { clientId: "app-1", patch: null }],
    ["patch array", { clientId: "app-1", patch: [] }],
    ["patch string", { clientId: "app-1", patch: "{}" }],
    ["clientId number", { clientId: 1, patch: {} }],
    ["clientId object", { clientId: { toString: "x" }, patch: {} }],
    ["clientId missing", { patch: {} }],
    ["whole input null", null],
    ["extra top-level url", { clientId: "app-1", patch: {}, url: "http://169.254.169.254/" }],
  ])("%s", async (_, data) => {
    const out = fns.updateClient({ data }).catch((e: unknown) => e);
    const res = await out;
    // An unknown top-level key is stripped (z.object), so it can never steer the call.
    if (data && typeof data === "object" && "url" in data) {
      expect(res).toEqual({ ok: true, data: "updated" });
      expect(fakeApi.updateClient).toHaveBeenCalledWith({}, "app-1", {});
      return;
    }
    expect(res).toBeInstanceOf(Error);
    expect(adminCallSpy).not.toHaveBeenCalled();
  });

  it("boundary values pass: 20 URIs of 2048 chars, null frontchannel, %2F / unicode / 128-char ids", async () => {
    const patch = {
      redirectUris: Array.from({ length: 20 }, () => long(2048)),
      frontchannelLogoutUri: null,
      grantTypes: ["authorization_code", "refresh_token"],
      disabled: false,
    };
    for (const clientId of ["%2F..%2F", "ứng-dụng", "x".repeat(128)]) {
      expect(await fns.updateClient({ data: { clientId, patch } })).toEqual({ ok: true, data: "updated" });
      expect(fakeApi.updateClient).toHaveBeenLastCalledWith({}, clientId, patch);
    }
  });
});

describe("listClients / getClient input", () => {
  it.each([
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { limit: "10" },
    { after: "" },
    { after: long(2049) },
    { after: 5 },
  ])("listClients(%j) refused", async (data) => {
    await expect(fns.listClients({ data })).rejects.toThrow();
    expect(adminCallSpy).not.toHaveBeenCalled();
  });

  it("listClients drops unknown keys (no path/method steering)", async () => {
    await fns.listClients({ data: { limit: 1, path: "/admin/users", method: "DELETE" } });
    expect(fakeApi.listClients).toHaveBeenCalledWith({}, { limit: 1 });
  });

  it.each([null, undefined, 42, ["app-1"], { id: "app-1" }])("getClient(%j) refused", async (data) => {
    await expect(fns.getClient({ data })).rejects.toThrow();
    expect(adminCallSpy).not.toHaveBeenCalled();
  });
});
