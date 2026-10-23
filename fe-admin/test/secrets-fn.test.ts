// @vitest-environment node
// Run 45 F2: the secrets server functions through the REAL `adminCall` + admin API client (only the
// BE fetch, the session and Start's request/response are faked): `no-store` on every answer of the
// issue function, the version validator, and no secret in a log, a failure or the result of a list.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "S3CR3T-canary-fn-0123456789";
let responseHeaders = new Headers();
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
  getRequest: () => new Request("http://localhost:3000/clients/app-1"),
  getResponseHeaders: () => responseHeaders,
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
let fns: { listSecrets: Fn; issueSecret: Fn; revokeSecret: Fn };
let logged: string[];

beforeEach(async () => {
  responseHeaders = new Headers();
  beFetch.mockReset();
  vi.stubGlobal("fetch", beFetch);
  logged = [];
  for (const level of ["error", "warn", "log", "info", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...a) => void logged.push(a.map(String).join(" ")));
  }
  fns = (await import("@/features/admin-api/secrets")) as never;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("issueSecret", () => {
  it("success: plaintext returned once, answer marked no-store", async () => {
    beFetch.mockResolvedValue(json(201, { clientId: "app-1", version: 2, clientSecret: SECRET }));
    expect(await fns.issueSecret({ data: "app-1" })).toEqual({ ok: true, data: { clientId: "app-1", version: 2, clientSecret: SECRET } });
    expect(responseHeaders.get("cache-control")).toBe("no-store");
    expect(responseHeaders.get("pragma")).toBe("no-cache");
    const [url, init] = beFetch.mock.calls[0]!;
    expect(url).toBe("http://idp.test/admin/clients/app-1/secrets");
    expect(init.method).toBe("POST");
    expect(logged.join("\n")).not.toContain(SECRET);
  });

  it.each([
    ["2xx off schema", () => json(201, { clientId: "app-1", version: "2", clientSecret: SECRET })],
    ["5xx", () => json(502, { clientSecret: SECRET })],
    ["step-up", () => json(403, { error: "step_up_required", error_description: SECRET })],
  ])("%s: still no-store; the failure and the logs never hold the secret", async (_, res) => {
    beFetch.mockResolvedValue(res());
    const result = (await fns.issueSecret({ data: "app-1" })) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(responseHeaders.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(logged.join("\n")).not.toContain(SECRET);
  });

  it("timeout-like network failure => uncertain failure, no-store, sent once", async () => {
    beFetch.mockRejectedValue(new TypeError("fetch failed"));
    expect(await fns.issueSecret({ data: "app-1" })).toEqual({
      ok: false,
      error: { code: "unavailable", message: expect.any(String), uncertain: true },
    });
    expect(responseHeaders.get("cache-control")).toBe("no-store");
    expect(beFetch).toHaveBeenCalledTimes(1);
  });

  it.each(["../x", "a/b", "", { clientId: "app-1" }])("input %j refused before the BE", async (data) => {
    await expect(fns.issueSecret({ data })).rejects.toThrow();
    expect(beFetch).not.toHaveBeenCalled();
  });
});

describe("revokeSecret", () => {
  it("204 => ok; BE DELETE on the version path", async () => {
    beFetch.mockResolvedValue(new Response(null, { status: 204 }));
    expect(await fns.revokeSecret({ data: { clientId: "app-1", version: 3 } })).toEqual({ ok: true, data: undefined });
    const [url, init] = beFetch.mock.calls[0]!;
    expect(url).toBe("http://idp.test/admin/clients/app-1/secrets/3");
    expect(init.method).toBe("DELETE");
  });

  it("404 => not_found", async () => {
    beFetch.mockResolvedValue(json(404, { error: "not_found" }));
    expect(await fns.revokeSecret({ data: { clientId: "app-1", version: 3 } })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it.each([0, -1, 1.5, 1e9, "1", "01", null, Number.NaN])("version %j refused, BE never called", async (version) => {
    await expect(fns.revokeSecret({ data: { clientId: "app-1", version } })).rejects.toThrow();
    expect(beFetch).not.toHaveBeenCalled();
  });

  it("boundary version 999999999 accepted", async () => {
    beFetch.mockResolvedValue(new Response(null, { status: 204 }));
    await fns.revokeSecret({ data: { clientId: "app-1", version: 999_999_999 } });
    expect(beFetch.mock.calls[0]![0]).toBe("http://idp.test/admin/clients/app-1/secrets/999999999");
  });
});

describe("listSecrets", () => {
  it("GET metadata only; never marked no-store (no secret in it)", async () => {
    beFetch.mockResolvedValue(json(200, { items: [{ version: 1, createdAt: "c", expiresAt: null, revokedAt: null, status: "active", secretHash: "h" }] }));
    const result = await fns.listSecrets({ data: "app-1" });
    expect(JSON.stringify(result)).not.toContain("secretHash");
    expect(beFetch.mock.calls[0]![1].method).toBe("GET");
  });
});
