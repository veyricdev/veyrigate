// @vitest-environment node
// Run 50 F2: `getBackendHealth` through the REAL `adminCall` + admin API client `readiness` (only the
// BE fetch, the session and Start's request/response are faked): signed-in only (no session => no
// BE request), GET `/ready` without a bearer, 3 s, never retried, and only `up` | `down` | `unknown`
// reaches the browser (no dependency name, no status, no body; the log has the route only).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const beFetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
const session = vi.fn<() => Promise<{ session: { key: string; token: string } | null; setCookie?: string }>>();
const setCookies: string[] = [];

vi.mock("@tanstack/react-start", () => ({
  createServerFn: (opts: { method: string }) => ({
    handler: (fn: () => unknown) => Object.assign(async () => fn(), { method: opts.method }),
  }),
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("http://localhost:3000/"),
  getResponseHeaders: () => ({ append: (_n: string, v: string) => void setCookies.push(v) }),
}));
vi.mock("@/server/env", () => ({
  serverEnv: () => ({ ADMIN_API_BASE_URL: "http://idp.test/", OIDC_ISSUER: "http://idp.test" }),
}));
vi.mock("@/server/auth/instance", () => ({
  getAuth: () => ({
    accessToken: () => session(),
    refreshRejected: async () => null,
    dropSession: async () => "fea_sid=; Max-Age=0",
  }),
}));

type Fn = (() => Promise<unknown>) & { method: string };
let getBackendHealth: Fn;
let logged: string[];

beforeEach(async () => {
  beFetch.mockReset();
  session.mockReset();
  session.mockResolvedValue({ session: { key: "k", token: "at-SECRET" } });
  setCookies.length = 0;
  vi.stubGlobal("fetch", beFetch);
  logged = [];
  for (const level of ["error", "warn", "log", "info", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...a) => void logged.push(a.map(String).join(" ")));
  }
  ({ getBackendHealth } = (await import("@/features/admin-api/health")) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const OK = { status: "ok", mongo: "up", redis: "up" };
const DOWN = { status: "error", mongo: "down", redis: "up" };

describe("getBackendHealth", () => {
  it("200 ok => up; GET {base}/ready, accept JSON, no authorization, no body, 3 s signal, manual redirect", async () => {
    beFetch.mockResolvedValue(json(200, OK));
    const out = await getBackendHealth();
    expect(getBackendHealth.method).toBe("GET");
    expect(out).toEqual({ ok: true, data: "up" });
    expect(beFetch).toHaveBeenCalledTimes(1);
    const [url, init] = beFetch.mock.calls[0]!;
    expect(url).toBe("http://idp.test/ready");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("accept")).toBe("application/json");
    expect(JSON.stringify(init)).not.toContain("at-SECRET");
    expect(logged).toEqual([]);
  });

  it("the request carries a 3 s timeout signal; when it fires => unknown", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort(new DOMException("t", "TimeoutError")));
    beFetch.mockImplementation(async (_u, init) => {
      init.signal!.throwIfAborted();
      return json(200, OK);
    });
    expect(await getBackendHealth()).toEqual({ ok: true, data: "unknown" });
    expect(timeout).toHaveBeenCalledWith(3000);
    expect(beFetch).toHaveBeenCalledTimes(1);
  });

  it("503 with an error body => down; the answer holds no dependency name", async () => {
    beFetch.mockResolvedValue(json(503, DOWN));
    const out = await getBackendHealth();
    expect(out).toEqual({ ok: true, data: "down" });
    expect(JSON.stringify(out)).not.toMatch(/mongo|redis/i);
  });

  it.each([
    ["200 with an unexpected body", async () => json(200, { status: "error", mongo: "down", redis: "up" })],
    ["200 with an unknown status", async () => json(200, { status: "degraded" })],
    ["200 not JSON", async () => new Response("<html>mongo redis</html>", { status: 200 })],
    ["503 not JSON", async () => new Response("Service Unavailable", { status: 503 })],
    ["503 with ok body", async () => json(503, OK)],
    ["500", async () => json(500, { status: "error", mongo: "down", redis: "down" })],
    ["404", async () => json(404, { error: "not_found" })],
    ["401", async () => json(401, { error: "unauthorized" })],
    ["302", async () => new Response(null, { status: 302, headers: { location: "http://evil.test/" } })],
    ["timeout", () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))],
    ["network", () => Promise.reject(new TypeError("fetch failed"))],
  ])("%s => unknown, one request (no retry), logged with the route only", async (_n, answer) => {
    beFetch.mockImplementation(answer);
    const out = await getBackendHealth();
    expect(out).toEqual({ ok: true, data: "unknown" });
    expect(JSON.stringify(out)).not.toMatch(/mongo|redis/i);
    expect(beFetch).toHaveBeenCalledTimes(1);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("admin api GET /ready failed");
    expect(logged.join(" ")).not.toMatch(/mongo|redis|evil|at-SECRET/i);
  });

  it("no session => unauthenticated and no BE request (not a probe for anonymous callers)", async () => {
    session.mockResolvedValue({ session: null, setCookie: "fea_sid=; Max-Age=0" });
    const out = await getBackendHealth();
    expect(out).toEqual({ ok: false, error: { code: "unauthenticated", message: expect.any(String) } });
    expect(beFetch).not.toHaveBeenCalled();
    expect(setCookies).toEqual(["fea_sid=; Max-Age=0"]);
  });

  it("a refreshed session's Set-Cookie is forwarded before the check", async () => {
    session.mockResolvedValue({ session: { key: "k", token: "at" }, setCookie: "fea_sid=new" });
    beFetch.mockResolvedValue(json(200, OK));
    expect(await getBackendHealth()).toEqual({ ok: true, data: "up" });
    expect(setCookies).toEqual(["fea_sid=new"]);
  });
});
