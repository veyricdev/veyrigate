// @vitest-environment node
// Run 50 (A6.6) tester risk matrix for `getBackendHealth` (REAL `adminCall` + `readiness`), beyond
// health-fn.test.ts: every 3xx (even with an "ok" body) / 204 / broken body stream => unknown and
// never followed; the browser's cookie / authorization never reach `/ready`; extra body fields
// (message / stack / dependency names) never leave the BFF; a session store failure is an error
// (not "up") with no BE request; parallel calls => exactly one request each.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const beFetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
const session = vi.fn<() => Promise<{ session: { key: string; token: string } | null; setCookie?: string }>>();
let incoming: Request;

vi.mock("@tanstack/react-start", () => ({
  createServerFn: (opts: { method: string }) => ({
    handler: (fn: () => unknown) => Object.assign(async () => fn(), { method: opts.method }),
  }),
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => incoming,
  getResponseHeaders: () => ({ append: () => undefined }),
}));
vi.mock("@/server/env", () => ({
  serverEnv: () => ({ ADMIN_API_BASE_URL: "http://idp.test//", OIDC_ISSUER: "http://idp.test" }),
}));
vi.mock("@/server/auth/instance", () => ({
  getAuth: () => ({
    accessToken: () => session(),
    refreshRejected: async () => null,
    dropSession: async () => "fea_sid=; Max-Age=0",
  }),
}));

type Fn = () => Promise<unknown>;
let getBackendHealth: Fn;
let logged: string[];

beforeEach(async () => {
  beFetch.mockReset();
  session.mockReset();
  session.mockResolvedValue({ session: { key: "k", token: "at-SECRET" } });
  incoming = new Request("http://localhost:3000/_serverFn/x", {
    headers: { cookie: "fea_sid=SID-SECRET", authorization: "Bearer BROWSER-SECRET", "x-forwarded-for": "198.51.100.7" },
  });
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

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const OK = { status: "ok", mongo: "up", redis: "up" };

describe("getBackendHealth risk", () => {
  it.each([301, 302, 303, 307, 308])("%i with an ok body => unknown, never followed", async (status) => {
    beFetch.mockResolvedValue(json(status, OK, { location: "http://evil.test/ready" }));
    expect(await getBackendHealth()).toEqual({ ok: true, data: "unknown" });
    expect(beFetch).toHaveBeenCalledTimes(1);
    expect(beFetch.mock.calls[0]![0]).toBe("http://idp.test/ready");
    expect(beFetch.mock.calls[0]![1].redirect).toBe("manual");
    expect(logged.join(" ")).not.toMatch(/evil|mongo|redis/i);
  });

  it.each([
    ["204 no body", async () => json(204, null)],
    ["200 ok body as text/html", async () => new Response(JSON.stringify({ status: "OK" }), { status: 200 })],
    ["200 array", async () => json(200, [OK])],
    ["200 null", async () => json(200, null)],
    [
      "200 broken body stream",
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('{"status":"o'));
              c.error(new Error("socket hang up mongo redis"));
            },
          }),
          { status: 200 },
        ),
    ],
    ["503 with status ok and dependency detail", async () => json(503, { status: "ok", mongo: "down", redis: "down" })],
  ])("%s => unknown", async (_n, answer) => {
    beFetch.mockImplementation(answer);
    const out = await getBackendHealth();
    expect(out).toEqual({ ok: true, data: "unknown" });
    expect(logged).toHaveLength(1);
    expect(logged[0]).not.toMatch(/mongo|redis|socket/i);
  });

  it("extra body fields (message, stack, host) never leave the BFF; the answer is exactly the enum", async () => {
    beFetch.mockResolvedValue(
      json(200, { status: "ok", mongo: "up", redis: "up", message: "db at 10.0.0.5", stack: "Error\n at x (/srv/app.js:1)" }),
    );
    const out = await getBackendHealth();
    expect(JSON.stringify(out)).toBe('{"ok":true,"data":"up"}');
    expect(logged).toEqual([]);
  });

  it("503 down with detail => exactly the enum", async () => {
    beFetch.mockResolvedValue(json(503, { status: "error", mongo: "down", redis: "down", message: "ECONNREFUSED 10.0.0.5" }));
    expect(JSON.stringify(await getBackendHealth())).toBe('{"ok":true,"data":"down"}');
  });

  it("the browser's cookie / authorization / forwarding headers never reach /ready", async () => {
    beFetch.mockResolvedValue(json(200, OK));
    await getBackendHealth();
    const init = beFetch.mock.calls[0]![1];
    const headers = new Headers(init.headers);
    expect([...headers.keys()]).toEqual(["accept"]);
    expect(JSON.stringify(init)).not.toMatch(/SECRET|198\.51/);
    expect(init.credentials).toBeUndefined();
  });

  it("session store failure => the call fails (never 'up'), no BE request", async () => {
    session.mockRejectedValue(Object.assign(new Error("Session store unavailable"), { name: "ServiceUnavailableError" }));
    await expect(getBackendHealth()).rejects.toThrow();
    expect(beFetch).not.toHaveBeenCalled();
  });

  it("5 parallel calls => exactly 5 requests (no fan-out, no retry)", async () => {
    beFetch.mockImplementation(async () => json(503, { status: "error", mongo: "down", redis: "up" }));
    const outs = await Promise.all(Array.from({ length: 5 }, () => getBackendHealth()));
    expect(outs.every((o) => JSON.stringify(o) === '{"ok":true,"data":"down"}')).toBe(true);
    expect(beFetch).toHaveBeenCalledTimes(5);
  });
});
