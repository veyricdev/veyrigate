// @vitest-environment node
// Run 59 (tester, DEBT-387/442): the `//` guard of the server entry must leave NO input for which the
// router answers its protocol-relative 308 (absolute `Location` built from `Host`). The router side is
// NOT mocked: `getNormalizedURL` is the real `@tanstack/router-core` function that
// `@tanstack/start-server-core` `createStartHandler` calls (resolved through the same dependency chain
// as the production bundle), and the stand-in handler reproduces exactly the bundle's pipeline: h3's
// `requestHandler` first builds `new H3Event(request)` (real `h3-v2` = h3@2.0.1-rc.20, which on srvx
// MUTATES the request's shared `_url`: `url.pathname = decodeURI(pathname)`; a URIError => 400), then
// `createStartHandler`:
//   const { url, handledProtocolRelativeURL } = getNormalizedURL(request.url);
//   if (handledProtocolRelativeURL) return Response.redirect(url, 308);
// The host is the real srvx node adapter (same version as `serve.mjs`), driven with byte-exact
// request targets (Node `http.request` sends `path` verbatim) and a hostile `Host`, so the guard and
// the router see exactly what production gives them (srvx's own URL building included).
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { serve } from "srvx/node";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type Normalize = (url: string) => { url: URL; handledProtocolRelativeURL: boolean };

// Plain function (hoisted declaration): the mock factory below runs lazily, at the first import of
// `@/server` in beforeAll, when the static imports are initialised.
function routerCorePaths(): { pkg: string; entry: string; h3: string } {
  // fe-admin -> @tanstack/react-start -> @tanstack/start-server-core -> @tanstack/router-core
  const req = createRequire(`${process.cwd()}/package.json`);
  const start = createRequire(req.resolve("@tanstack/react-start/package.json"));
  const server = createRequire(start.resolve("@tanstack/start-server-core/package.json"));
  const pkg = server.resolve("@tanstack/router-core/package.json");
  const h3Pkg = server.resolve("h3-v2/package.json");
  return {
    pkg,
    entry: pkg.replace(/package\.json$/, "dist/esm/ssr/ssr-server.js"),
    h3: h3Pkg.replace(/package\.json$/, "dist/_entries/node.mjs"),
  };
}

const calls = vi.hoisted(() => ({ router: 0, redirects: [] as string[] }));

vi.mock("@tanstack/react-start/server-entry", async () => {
  const { getNormalizedURL } = (await import(pathToFileURL(routerCorePaths().entry).href)) as {
    getNormalizedURL: Normalize;
  };
  const { H3Event } = (await import(pathToFileURL(routerCorePaths().h3).href)) as {
    H3Event: new (request: Request) => unknown;
  };
  return {
    default: {
      fetch: async (request: Request) => {
        try {
          new H3Event(request); // the side effect on request._url is the point
        } catch (error) {
          if (error instanceof URIError) return new Response(null, { status: 400 });
          throw error;
        }
        calls.router += 1;
        const { url, handledProtocolRelativeURL } = getNormalizedURL(request.url);
        if (handledProtocolRelativeURL) {
          calls.redirects.push(`${request.url} -> ${url.href}`);
          return Response.redirect(url, 308);
        }
        return new Response("router", { status: 200 });
      },
    },
    createServerEntry: (entry: unknown) => entry,
  };
});
vi.mock("@/server/env", () => ({
  serverEnv: () => ({ APP_URL: "https://admin.example", OIDC_ISSUER: "https://idp.example" }),
}));

type Entry = { fetch: (request: Request) => Promise<Response> };
let getNormalizedURL: Normalize;
let entry: Entry;
let server: ReturnType<typeof serve>;
let port = 0;
const agent = new http.Agent({ keepAlive: true, maxSockets: 16 });

type Res = { status: number; location: string | undefined; csp: string | undefined; body: string };
function raw(path: string, host = "evil.example", method = "GET"): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, agent, headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("latin1");
      res.on("data", (d: string) => (body += d));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? -1,
          location: res.headers.location,
          csp: res.headers["content-security-policy"] as string | undefined,
          body,
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** Every `/` + up to `depth` tokens: the separators/encodings the router and WHATWG treat specially. */
const TOKENS = ["/", "\\", ".", "..", "%2e", "%2F", "%5C", "%09", "a", "?"];
// DEBT-447 (senior fuzz, run 59 round 2): h3 `decodePathname` handles `%25` before `decodeURI`, upper/lower
// case escapes differ for WHATWG dot-segments, `%0D` is dropped by the setter, `%E0` alone is a URIError
// (h3 400), `%3F`/`%23` stay encoded. Smaller depth: the product of 18 tokens grows fast.
const TOKENS_DECODE = [...TOKENS, "%25", "%2525", "%2E", "%5c", "%0D", "%E0", "%3F", "%23"];
function corpus(depth: number, tokens: string[] = TOKENS): string[] {
  let level = [""];
  const all: string[] = [];
  for (let d = 0; d < depth; d++) {
    level = level.flatMap((p) => tokens.map((t) => p + t));
    all.push(...level);
  }
  return ["/", ...all.map((s) => `/${s}`)];
}

beforeAll(async () => {
  ({ getNormalizedURL } = (await import(pathToFileURL(routerCorePaths().entry).href)) as { getNormalizedURL: Normalize });
  entry = (await import("@/server")).default as unknown as Entry;
  server = serve({ fetch: (r: Request) => entry.fetch(r), port: 0, hostname: "127.0.0.1", silent: true });
  await server.ready();
  port = (server.node!.server!.address() as AddressInfo).port;
});

afterAll(async () => {
  agent.destroy();
  await server?.close(true);
});

describe("DEBT-442: router-core resolved as in the production bundle", () => {
  it("is the version the fold verified (1.171.34): a bump must re-run this file knowingly", () => {
    const { version } = createRequire(import.meta.url)(routerCorePaths().pkg) as { version: string };
    expect(version).toBe("1.171.34");
  });

  it("h3 (h3-v2 of start-server-core) and srvx are the versions whose URL rewriting the guard copies", () => {
    const load = createRequire(import.meta.url);
    const h3 = load(routerCorePaths().h3.replace(/dist\/_entries\/node\.mjs$/, "package.json")) as { version: string };
    const srvx = load(`${process.cwd()}/node_modules/srvx/package.json`) as { version: string };
    expect([h3.version, srvx.version]).toEqual(["2.0.1-rc.20", "0.11.22"]);
  });

  it("tripwire: the real getNormalizedURL still answers `//x` with a protocol-relative redirect", () => {
    // Without this the corpus below could pass only because the router stopped redirecting.
    const r = getNormalizedURL("http://evil.example//a");
    expect(r.handledProtocolRelativeURL).toBe(true);
    expect(r.url.href).toBe("http://evil.example/a");
  });
});

describe("DEBT-442: no request the guard lets through reaches the router's 308 (real srvx, raw targets)", () => {
  it("senior's variants, Host: evil.example => never 308, never a Location", async () => {
    const variants = [
      "//a",
      "//evil.example/x?y=1",
      "///a",
      "//",
      "/\\evil.example",
      "/\\/evil",
      "/\\\\..//a",
      "/%2e%2e//a",
      "/a/..//b",
      "/./%2e//a",
      "//..\\x/y",
      "/..//a",
      "/a/%2e%2e//b",
      "/%5C%5Cevil.example",
      "/%5Cevil.example",
      "/%5c/evil.example",
      "/%09/evil.example",
      "/%0A/evil.example",
      "/%2F%2Fevil.example",
      "//healthz",
      "//assets/x",
      "http://evil.example//a",
      "http://evil.example//..\\x",
      "http://evil.example/\\evil.example",
      "http://evil.example/a/..//b",
    ];
    for (const method of ["GET", "HEAD", "POST"]) {
      const before = calls.redirects.length;
      for (const path of variants) {
        const res = await raw(path, "evil.example", method);
        expect([method, path, res.status, res.location]).toEqual([method, path, expect.any(Number), undefined]);
        expect(res.status).not.toBe(308);
        expect(res.csp).toContain("frame-ancestors 'none'");
      }
      expect(calls.redirects.slice(before)).toEqual([]);
    }
  });

  it("exhaustive corpus (depth 4, origin-form and absolute-form): 0 redirects, both branches exercised", async () => {
    const paths = corpus(4);
    const targets = [...paths, ...corpus(3).map((p) => `http://evil.example${p}`)];
    const routerBefore = calls.router;
    const results = await pool(targets, 16, async (path) => ({ path, res: await raw(path) }));
    const bad = results.filter(({ res }) => res.status === 308 || res.location !== undefined || res.status < 0);
    expect(bad.map(({ path, res }) => `${path} ${res.status} ${res.location}`)).toEqual([]);
    expect(calls.redirects).toEqual([]);
    // the guard answered some (404 "Not Found"), the router answered the others ("router")
    const guarded = results.filter(({ res }) => res.status === 404 && res.body === "Not Found").length;
    const routed = results.filter(({ res }) => res.body === "router").length;
    console.info(`[run59-tester] DEBT-442 corpus: ${targets.length} targets, guard 404 ${guarded}, router ${routed}`);
    expect(guarded).toBeGreaterThan(1000);
    expect(routed).toBeGreaterThan(1000);
    expect(calls.router - routerBefore).toBe(routed);
  }, 120_000);

  it("decode corpus (DEBT-447: %25, %2E, %0D, %E0, %3F, %23 ..., depth 3, both forms): 0 redirects", async () => {
    const targets = [...corpus(3, TOKENS_DECODE), ...corpus(2, TOKENS_DECODE).map((p) => `http://evil.example${p}`)];
    const before = calls.redirects.length;
    const results = await pool(targets, 16, async (path) => ({ path, res: await raw(path) }));
    const bad = results.filter(({ res }) => res.status === 308 || res.location !== undefined || res.status < 0);
    expect(bad.map(({ path, res }) => `${path} ${res.status} ${res.location}`)).toEqual([]);
    expect(calls.redirects.slice(before)).toEqual([]);
    const count = (f: (r: Res) => boolean) => results.filter(({ res }) => f(res)).length;
    const guarded = count((r) => r.status === 404 && r.body === "Not Found");
    const routed = count((r) => r.body === "router");
    const h3400 = count((r) => r.status === 400);
    console.info(`[run59-tester] DEBT-447 corpus: ${targets.length} targets, guard 404 ${guarded}, router ${routed}, h3 400 ${h3400}`);
    expect(guarded).toBeGreaterThan(500);
    expect(routed).toBeGreaterThan(500);
    expect(h3400).toBeGreaterThan(0);
  }, 120_000);

  it("in-process (no h3: only the paths without `%` are meaningful here): for every corpus URL the guard passes, new Request(url).url never triggers the router 308", () => {
    let passed = 0;
    for (const p of corpus(4)) {
      let url: string;
      try {
        url = new Request(`http://evil.example${p}`).url;
      } catch {
        continue;
      }
      const { pathname } = new URL(url);
      if (pathname.startsWith("//") || pathname.startsWith("/assets/") || pathname === "/healthz") continue;
      passed += 1;
      expect([p, getNormalizedURL(url).handledProtocolRelativeURL]).toEqual([p, false]);
    }
    expect(passed).toBeGreaterThan(5_000);
  }, 60_000);
});

describe("DEBT-446: the Location guard stops the router's 308 whatever parsed the path", () => {
  it("DEBT-446 real getNormalizedURL on the raw senior sample => 308 wrapped by withSecurityHeaders => 404", async () => {
    const { withSecurityHeaders } = await import("@/server/security-headers");
    const { url, handledProtocolRelativeURL } = getNormalizedURL("http://evil.example//..\\x/y");
    expect(handledProtocolRelativeURL).toBe(true);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await withSecurityHeaders(() => Response.redirect(url, 308), {
        appUrl: "https://admin.example",
        issuer: "https://idp.example",
      });
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });
});
