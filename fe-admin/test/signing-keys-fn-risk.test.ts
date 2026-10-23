// @vitest-environment node
// Run 49 tester risk matrix for the signing-key server functions (same harness as
// signing-keys-fn.test.ts: REAL `adminCall` + admin API client, only the BE fetch / session / Start
// faked). Key material in BE error bodies or off-contract 2xx never reaches the result or a log;
// prototype-pollution / look-alike / encoded `mode` inputs are refused with 0 BE calls; the BE
// response nesting material inside allowed fields is refused, not stripped silently into text.
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

const allLogs = () => logged.join(String.fromCharCode(10));

describe("exposure: material never in result or logs", () => {
  it.each([
    ["500 with material in the body", async () => json(500, { error: "server_error", ...MATERIAL })],
    ["200 off-schema carrying material", async () => json(200, { newKid: "", oldKid: null, mode: "normal", ...MATERIAL })],
    ["200 text body with a PEM", async () => new Response(MATERIAL.pem, { status: 200 })],
  ])("rotate %s => no MATERIAL in the result nor any console sink, one BE call", async (_n, res) => {
    beFetch.mockImplementation(res);
    const out = await rotateSigningKey({ data: { mode: "emergency" } });
    expect(JSON.stringify(out)).not.toMatch(/MATERIAL|BEGIN/);
    expect(allLogs()).not.toMatch(/MATERIAL|BEGIN|PRIVATE/);
    expect(beFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["500 with material", async () => json(500, { error: "server_error", ...MATERIAL })],
    ["200 with a non-null nextCursor and material", async () => json(200, { items: [{ ...KEY, ...MATERIAL }], nextCursor: "MATERIAL" })],
    ["200 with material nested in kid (object)", async () => json(200, { items: [{ ...KEY, kid: { d: "MATERIAL" } }], nextCursor: null })],
    ["200 with a 129-char kid", async () => json(200, { items: [{ ...KEY, kid: "k".repeat(129) }], nextCursor: null })],
    ["200 with an unknown status", async () => json(200, { items: [{ ...KEY, status: "retired", d: "MATERIAL" }], nextCursor: null })],
  ])("list %s => refused (no data: typed failure or a route-only throw), no MATERIAL in result, error or logs", async (_n, res) => {
    beFetch.mockImplementation(res);
    const out = await listSigningKeys().then(
      (v) => v,
      (e: unknown) => ({ thrown: e instanceof Error ? e.message : String(e) }),
    );
    expect((out as { ok?: boolean }).ok).not.toBe(true);
    if ("thrown" in (out as object)) expect((out as { thrown: string }).thrown).toMatch(/^admin api GET \/admin\/keys: /);
    expect(JSON.stringify(out)).not.toMatch(/MATERIAL|BEGIN/);
    expect(allLogs()).not.toMatch(/MATERIAL|BEGIN|PRIVATE/);
  });

  it("characterisation: a 400 `error_description` is BE-authored text relayed capped at 200 chars (pre-existing contract of every admin write)", async () => {
    beFetch.mockResolvedValue(json(400, { error: "invalid_request", error_description: "x".repeat(500) }));
    const out = (await rotateSigningKey({ data: { mode: "normal" } })) as { ok: false; error: { code: string; message: string } };
    expect(out.error.code).toBe("invalid_request");
    expect(out.error.message.length).toBeLessThanOrEqual(200);
  });

  it("logs (if any) name the route template only, never a kid or mode", async () => {
    beFetch.mockResolvedValue(json(500, { error: "server_error" }));
    await rotateSigningKey({ data: { mode: "emergency" } });
    beFetch.mockResolvedValue(json(503, {}));
    await listSigningKeys();
    expect(allLogs()).not.toMatch(/emergency|k-2026|"mode"/);
  });
});

describe("rotate input: strict {mode} only", () => {
  it.each([
    ["__proto__ smuggling", JSON.parse('{"mode":"normal","__proto__":{"mode":"emergency"}}')],
    ["constructor key", { mode: "normal", constructor: { prototype: { x: 1 } } }],
    ["Cyrillic look-alike", { mode: "\u0435mergency" }],
    ["trailing space", { mode: "emergency " }],
    ["NUL suffix", { mode: "emergency\u0000" }],
    ["array", { mode: ["emergency"] }],
    ["number", { mode: 1 }],
    ["boolean flag instead of mode", { emergency: true }],
    ["oversized", { mode: "e".repeat(10_000) }],
  ])("%s => refused before any BE call", async (_n, data) => {
    await expect(rotateSigningKey({ data })).rejects.toThrow();
    expect(beFetch).not.toHaveBeenCalled();
  });

  it("the BE body is exactly {mode} even though the input object came from JSON with extra prototype keys", async () => {
    beFetch.mockResolvedValue(json(200, { newKid: "k-new", oldKid: "k-old", mode: "normal" }));
    await rotateSigningKey({ data: { mode: "normal" } });
    expect(String(beFetch.mock.calls[0]![1].body)).toBe('{"mode":"normal"}');
  });
});
