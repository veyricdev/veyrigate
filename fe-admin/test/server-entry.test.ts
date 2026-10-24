// @vitest-environment node
// Run 52: the server entry answers `/healthz` (liveness, no dependency) and refuses a body that is
// too large / malformed / unbounded before the router sees it (DEBT-370), all with the A7 headers.
import { beforeEach, describe, expect, it, vi } from "vitest";

const routerFetch = vi.hoisted(() => vi.fn(async () => new Response("router", { status: 404 })));
const env = vi.hoisted(() => ({ valid: true }));

vi.mock("@tanstack/react-start/server-entry", () => ({
  default: { fetch: routerFetch },
  createServerEntry: (entry: unknown) => entry,
}));
vi.mock("@/server/env", () => ({
  serverEnv: () => {
    if (!env.valid) throw new Error("Invalid server environment variables");
    return { APP_URL: "https://admin.example", OIDC_ISSUER: "https://idp.example" };
  },
}));

type Entry = { fetch: (request: Request, opts?: unknown) => Promise<Response> };
async function entry(valid = true): Promise<Entry> {
  vi.resetModules();
  env.valid = valid;
  return (await import("@/server")).default as unknown as Entry;
}

const URL_BASE = "http://localhost:3000";
const post = (path: string, headers: Record<string, string>, body?: BodyInit) =>
  new Request(URL_BASE + path, { method: "POST", headers, body });

function expectA7(res: Response) {
  expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("cache-control")).toBe("no-store");
}

beforeEach(() => routerFetch.mockClear());

describe("/healthz", () => {
  it("GET => 200 `ok`, text/plain, no-store + A7 headers, router not called", async () => {
    const res = await (await entry()).fetch(new Request(`${URL_BASE}/healthz`));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expectA7(res);
    expect(routerFetch).not.toHaveBeenCalled();
  });

  it("HEAD => 200 too", async () => {
    const res = await (await entry()).fetch(new Request(`${URL_BASE}/healthz`, { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(routerFetch).not.toHaveBeenCalled();
  });

  it("env invalid => 500 (the boot self-check fails)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await (await entry(false)).fetch(new Request(`${URL_BASE}/healthz`));
    log.mockRestore();
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal Server Error");
    expectA7(res);
  });

  it("POST /healthz and /healthz/x are not the health check: they go to the router", async () => {
    const app = await entry();
    const posted = await app.fetch(post("/healthz", { "content-length": "0" }));
    expect(posted.status).not.toBe(200);
    expect(await posted.text()).not.toBe("ok");
    const nested = await app.fetch(new Request(`${URL_BASE}/healthz/x`));
    expect(await nested.text()).toBe("router");
    expect(routerFetch).toHaveBeenCalledTimes(2);
  });
});

describe("/assets/* that reached the app (missing asset)", () => {
  it("=> plain 404 with the A7 headers, not the router's login redirect", async () => {
    const res = await (await entry()).fetch(new Request(`${URL_BASE}/assets/khong-ton-tai.js`));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
    expectA7(res);
    expect(routerFetch).not.toHaveBeenCalled();
  });
});

describe("DEBT-370 body limit (any method but GET/HEAD/OPTIONS)", () => {
  it("65 536 bytes declared => passed to the router", async () => {
    const res = await (await entry()).fetch(post("/_serverFn/x", { "content-length": "65536" }, "x".repeat(65_536)));
    expect(await res.text()).toBe("router");
    expect(routerFetch).toHaveBeenCalledTimes(1);
  });

  it("65 537 bytes => 413 Payload Too Large with CSP, nosniff, no-store; router not called", async () => {
    const res = await (await entry()).fetch(post("/_serverFn/x", { "content-length": "65537" }, "x".repeat(65_537)));
    expect(res.status).toBe(413);
    expect(await res.text()).toBe("Payload Too Large");
    expectA7(res);
    expect(routerFetch).not.toHaveBeenCalled();
  });

  it("a body stream without Content-Length (chunked) => 411; router not called", async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("{}"));
        c.close();
      },
    });
    const req = new Request(`${URL_BASE}/_serverFn/x`, { method: "POST", body, duplex: "half" } as RequestInit);
    const res = await (await entry()).fetch(req);
    expect(res.status).toBe(411);
    expect(await res.text()).toBe("Length Required");
    expectA7(res);
    expect(routerFetch).not.toHaveBeenCalled();
  });

  it.each(["abc", "-1", "1e3", "1.5", "0x10"])("Content-Length %j => 400, value not echoed", async (value) => {
    const res = await (await entry()).fetch(post("/_serverFn/x", { "content-length": value }));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Bad Request");
    expectA7(res);
    expect(routerFetch).not.toHaveBeenCalled();
  });

  it("PUT/PATCH/DELETE are limited too", async () => {
    const app = await entry();
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await app.fetch(new Request(`${URL_BASE}/x`, { method, headers: { "content-length": "70000" } }));
      expect(res.status).toBe(413);
    }
    expect(routerFetch).not.toHaveBeenCalled();
  });

  it("GET with a long query string is not limited", async () => {
    const res = await (await entry()).fetch(new Request(`${URL_BASE}/clients?q=${"a".repeat(70_000)}`));
    expect(await res.text()).toBe("router");
  });

  it("a small POST /auth/logout (form body) goes through", async () => {
    const res = await (await entry()).fetch(
      post("/auth/logout", { "content-length": "0", "sec-fetch-site": "same-origin" }),
    );
    expect(await res.text()).toBe("router");
    expect(routerFetch).toHaveBeenCalledTimes(1);
  });
});
