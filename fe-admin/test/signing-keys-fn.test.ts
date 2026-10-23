// @vitest-environment node
// Run 49 F2: the signing-key server functions through the REAL `adminCall` + admin API client (only
// the BE fetch, the session and Start's request/response are faked): the response allowlist strips
// every key member / PEM / path, the rotate input is `{mode}` only (refused before any BE call), and
// an unknown rotate outcome is `uncertain` and sent exactly once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const beFetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

vi.mock("@tanstack/react-start", () => ({
  createServerFn: (opts: { method: string }) => ({
    // listSigningKeys: no input
    handler: (fn: () => unknown) => Object.assign(async () => fn(), { method: opts.method }),
    inputValidator: (schema: { parse: (v: unknown) => unknown }) => ({
      handler: (fn: (o: { data: unknown }) => unknown) =>
        Object.assign(async (o: { data: unknown }) => fn({ data: schema.parse(o.data) }), { method: opts.method }),
    }),
  }),
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("http://localhost:3000/keys"),
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

type Fn = ((o?: { data: unknown }) => Promise<unknown>) & { method: string };
let listSigningKeys: Fn;
let rotateSigningKey: Fn;
let logged: string[];

beforeEach(async () => {
  beFetch.mockReset();
  vi.stubGlobal("fetch", beFetch);
  logged = [];
  for (const level of ["error", "warn", "log", "info", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...a) => void logged.push(a.map(String).join(" ")));
  }
  ({ listSigningKeys, rotateSigningKey } = (await import("@/features/admin-api/signing-keys")) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const KEY = {
  kid: "k-2026-10-23",
  alg: "RS256",
  status: "active",
  createdAt: "2026-10-23T01:02:03.004Z",
  retireAt: null,
};
const RETIRING = { ...KEY, kid: "k-old", status: "retiring", retireAt: "2026-10-23T01:04:03.004Z" };
const MATERIAL = {
  kty: "RSA",
  n: "MATERIAL-n",
  e: "AQAB",
  d: "MATERIAL-d",
  p: "MATERIAL-p",
  q: "MATERIAL-q",
  dp: "MATERIAL-dp",
  dq: "MATERIAL-dq",
  qi: "MATERIAL-qi",
  pem: "-----BEGIN PRIVATE KEY-----MATERIAL",
  path: "/srv/keys/MATERIAL.pem",
  privateKey: "MATERIAL-private",
};

describe("listSigningKeys", () => {
  it("GET /admin/keys; only the 5 allowlisted fields reach the caller (no key material)", async () => {
    beFetch.mockResolvedValue(json(200, { items: [{ ...KEY, ...MATERIAL }, { ...RETIRING, ...MATERIAL }], nextCursor: null, extra: "MATERIAL" }));
    const out = await listSigningKeys();
    expect(listSigningKeys.method).toBe("GET");
    expect(out).toEqual({ ok: true, data: { items: [KEY, RETIRING], nextCursor: null } });
    expect(JSON.stringify(out)).not.toContain("MATERIAL");
    expect(beFetch).toHaveBeenCalledTimes(1);
    const [url, init] = beFetch.mock.calls[0]!;
    expect(url).toBe("http://idp.test/admin/keys");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(logged).toEqual([]);
  });

  it.each([
    [403, { error: "forbidden" }, "forbidden"],
    [403, { error: "insufficient_scope" }, "forbidden"],
  ] as const)("%i %j => %s, not uncertain", async (status, body, code) => {
    beFetch.mockResolvedValue(json(status, body));
    expect(await listSigningKeys()).toEqual({ ok: false, error: { code, message: expect.any(String) } });
  });
});

describe("rotateSigningKey", () => {
  it.each(["normal", "emergency"] as const)("POST /admin/keys/rotate with exactly {mode:%s}; result stripped", async (mode) => {
    beFetch.mockResolvedValue(json(200, { newKid: "k-new", oldKid: "k-old", mode, privateKey: "MATERIAL", d: "MATERIAL" }));
    const out = await rotateSigningKey({ data: { mode } });
    expect(rotateSigningKey.method).toBe("POST");
    expect(out).toEqual({ ok: true, data: { newKid: "k-new", oldKid: "k-old", mode } });
    expect(JSON.stringify(out)).not.toContain("MATERIAL");
    expect(beFetch).toHaveBeenCalledTimes(1);
    const [url, init] = beFetch.mock.calls[0]!;
    expect(url).toBe("http://idp.test/admin/keys/rotate");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ mode });
  });

  it("oldKid null (first key) is accepted", async () => {
    beFetch.mockResolvedValue(json(200, { newKid: "k-new", oldKid: null, mode: "normal" }));
    expect(await rotateSigningKey({ data: { mode: "normal" } })).toEqual({ ok: true, data: { newKid: "k-new", oldKid: null, mode: "normal" } });
  });

  it.each([
    ["wrong case", { mode: "EMERGENCY" }],
    ["unknown mode", { mode: "hard" }],
    ["extra key", { mode: "normal", x: 1 }],
    ["missing mode", {}],
    ["not an object", "emergency"],
    ["null", null],
  ])("input %s is refused before any BE call", async (_, data) => {
    await expect(rotateSigningKey({ data })).rejects.toThrow();
    expect(beFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["timeout", () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))],
    ["network", () => Promise.reject(new TypeError("fetch failed"))],
    ["500", async () => json(500, { error: "server_error" })],
    ["200 off schema", async () => json(200, { newKid: "", oldKid: null, mode: "normal" })],
    ["200 unknown mode", async () => json(200, { newKid: "k-new", oldKid: null, mode: "hard" })],
    ["200 not JSON", async () => new Response("<html>", { status: 200 })],
  ])("%s => unavailable + uncertain, sent exactly once", async (_, res) => {
    beFetch.mockImplementation(res);
    expect(await rotateSigningKey({ data: { mode: "emergency" } })).toEqual({
      ok: false,
      error: { code: "unavailable", message: expect.any(String), uncertain: true },
    });
    expect(beFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [403, { error: "step_up_required" }, "step_up_required"],
    [403, { error: "forbidden" }, "forbidden"],
    [400, { error: "invalid_request", error_description: "mode must be one of" }, "invalid_request"],
  ] as const)("%i %j => %s, not uncertain, sent once", async (status, body, code) => {
    beFetch.mockResolvedValue(json(status, body));
    const out = (await rotateSigningKey({ data: { mode: "normal" } })) as { ok: false; error: { code: string; uncertain?: true } };
    expect(out.error.code).toBe(code);
    expect(out.error.uncertain).toBeUndefined();
    expect(beFetch).toHaveBeenCalledTimes(1);
  });
});
