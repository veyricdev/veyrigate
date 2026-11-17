// @vitest-environment node
// Run 52 (tester): the real `serve.mjs` (srvx host of the production build) run as a child process
// against a fixture build, so no `vite build` and no Docker are needed. Raw HTTP over a socket keeps
// paths byte-exact (no client normalisation): traversal must never reach `dist/server`, the fixture
// root (`package.json`, `serve.mjs`) or files outside `dist/client/assets`; only GET/HEAD are served
// as assets, with nosniff + immutable; a failing boot self-check exits 1 without printing env values.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { devNull } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileP = promisify(execFile);
const FE_ADMIN = fileURLToPath(new URL("..", import.meta.url));
// Under fe-admin/node_modules (gitignored): `srvx` resolves from fe-admin/node_modules as in the image.
const ROOT = `${FE_ADMIN}node_modules/.cache/serve-mjs-risk-${process.pid}-${randomBytes(4).toString("hex")}`;
const ASSET = "app-Ab12Cd34.js";
const BIG_ASSET = "big-Ef56Gh78.js"; // several socket chunks, like the real index bundle (~400 KB)
const MARK = {
  asset: "ASSET_BODY_MARK",
  server: "SERVER_BUNDLE_MARK",
  pkg: "FIXTURE_PACKAGE_MARK",
  robots: "CLIENT_ROOT_FILE_MARK",
};

function writeFixture() {
  mkdirSync(`${ROOT}/dist/server`, { recursive: true });
  mkdirSync(`${ROOT}/dist/client/assets`, { recursive: true });
  copyFileSync(`${FE_ADMIN}serve.mjs`, `${ROOT}/serve.mjs`);
  writeFileSync(`${ROOT}/package.json`, JSON.stringify({ type: "module", description: MARK.pkg, dependencies: {} }));
  writeFileSync(`${ROOT}/dist/client/assets/${ASSET}`, `console.log("${MARK.asset}");\n`);
  writeFileSync(`${ROOT}/dist/client/assets/${BIG_ASSET}`, `// ${"x".repeat(512 * 1024)}\n`);
  writeFileSync(`${ROOT}/dist/client/robots.txt`, MARK.robots);
  // Stand-in for the Start bundle: healthz unless FIXTURE_BROKEN, everything else a marked 404.
  writeFileSync(
    `${ROOT}/dist/server/server.js`,
    `// ${MARK.server}
export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (process.env.FIXTURE_BROKEN) { console.error("env invalid: SESSION_SECRET"); return new Response("Internal Server Error", { status: 500 }); }
    if (pathname === "/healthz") return new Response("ok");
    // DEBT-679 (run 93): app/BFF response streams that the client may abandon mid-body.
    if (pathname === "/slow-stream" || pathname === "/error-stream") {
      const chunk = new TextEncoder().encode("y".repeat(64 * 1024));
      let n = 0;
      return new Response(new ReadableStream({
        async pull(controller) {
          if (n++ > 0) await new Promise((r) => setTimeout(r, 50));
          if (pathname === "/error-stream" && n === 3) return controller.error(new Error("upstream reset"));
          if (n > 200) return controller.close();
          controller.enqueue(chunk);
        },
      }), { headers: { "content-type": "text/plain" } });
    }
    if (pathname === "/fast-stream") {
      let n = 0;
      return new Response(new ReadableStream({
        pull(controller) {
          if (n++ >= 10) return controller.close();
          controller.enqueue(new TextEncoder().encode("w".repeat(60 * 1024)));
        },
      }), { headers: { "content-type": "text/plain" } });
    }
    // The BFF does not pass upstream bodies through today (admin-api reads JSON): this route guards
    // the day a passthrough is added.
    if (pathname === "/proxy") {
      const upstream = await fetch(process.env.FIXTURE_UPSTREAM);
      return new Response(upstream.body, { status: upstream.status, headers: { "content-type": "text/plain" } });
    }
    return new Response("app-404", { status: 404, headers: { "x-from": "app" } });
  },
};
`,
  );
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

type Raw = { status: number; headers: Record<string, string>; body: string };
function raw(port: number, method: string, path: string, extra = ""): Promise<Raw> {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => (buf = Buffer.concat([buf, d])));
    sock.on("error", () => resolve({ status: -1, headers: {}, body: "" }));
    sock.on("close", () => {
      const text = buf.toString("latin1");
      const split = text.indexOf("\r\n\r\n");
      const [statusLine, ...lines] = (split < 0 ? text : text.slice(0, split)).split("\r\n");
      const headers: Record<string, string> = {};
      for (const line of lines) {
        const i = line.indexOf(":");
        if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
      }
      resolve({ status: Number(statusLine?.split(" ")[1] ?? -1), headers, body: split < 0 ? "" : text.slice(split + 4) });
    });
    sock.write(`${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n${extra}\r\n`);
  });
}

function start(port: number, extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["serve.mjs"], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", HOST: "127.0.0.1", PORT: String(port), ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = { text: "" };
  child.stdout?.on("data", (d) => (log.text += d));
  child.stderr?.on("data", (d) => (log.text += d));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, log, exited };
}

/** Poll until /healthz answers 200 (condition, not a fixed sleep) or the process exits / deadline. */
async function ready(port: number, child: ChildProcess, deadlineMs = 15_000) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end && child.exitCode === null) {
    if ((await raw(port, "GET", "/healthz")).status === 200) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

let port = 0;
let server: ReturnType<typeof start>;
// Slow local upstream for the BFF passthrough case: 64 KB chunks every 50 ms (~13 MB), like a backend
// answer the BFF forwards without buffering.
let upstream: http.Server;
let upstreamPort = 0;

beforeAll(async () => {
  writeFixture();
  upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    let n = 0;
    const timer = setInterval(() => {
      if (n++ > 200 || res.destroyed) {
        clearInterval(timer);
        return res.end();
      }
      res.write("z".repeat(64 * 1024));
    }, 50);
    res.on("close", () => clearInterval(timer));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as net.AddressInfo).port;
  port = await freePort();
  server = start(port, { FIXTURE_UPSTREAM: `http://127.0.0.1:${upstreamPort}/` });
  expect(await ready(port, server.child), server.log.text).toBe(true);
}, 30_000);

afterAll(async () => {
  if (server?.child.exitCode === null) {
    server.child.kill();
    await server.exited;
  }
  upstream?.closeAllConnections();
  await new Promise((r) => upstream?.close(r));
  rmSync(ROOT, { recursive: true, force: true });
});

describe("serve.mjs assets middleware", () => {
  it("GET /assets/<hashed>.js => 200 file, text/javascript, nosniff, immutable", async () => {
    const res = await raw(port, "GET", `/assets/${ASSET}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain(MARK.asset);
    expect(res.headers["content-type"]).toBe("text/javascript");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  // Run 92 (CI fe-admin-image check 6 "connection reset"): re-wrapping the static Response body in a new
  // Response made it a web byte stream; a client closing the socket while a read was still pending (curl,
  // right after the last byte; the raw clients here are too slow to hit it) cancelled the stream and
  // undici then closed it again: an uncaught ERR_INVALID_STATE that killed the process. curl is the client
  // of the image smoke and exists on the CI runner and on Windows 10+; missing => the test fails.
  it("the process survives curl fetching assets (closes the socket right after the body)", async () => {
    // BIG_ASSET 5 times (run 93): one fetch hit the run 92 crash only about every other run.
    for (const path of [ASSET, BIG_ASSET, BIG_ASSET, BIG_ASSET, BIG_ASSET, BIG_ASSET, ASSET]) {
      const { stdout } = await execFileP("curl", ["-sS", "-o", devNull, "-w", "%{http_code}", `http://127.0.0.1:${port}/assets/${path}`]);
      expect(stdout).toBe("200");
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(server.child.exitCode, server.log.text).toBeNull();
    expect(server.log.text).not.toContain("ERR_INVALID_STATE");
    expect((await raw(port, "GET", "/assets/khong-ton-tai.js")).headers["x-from"]).toBe("app");
  }, 30_000);

  it("HEAD => 200, same headers, no body; gzip-encoded GET keeps the headers", async () => {
    const head = await raw(port, "HEAD", `/assets/${ASSET}`);
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers["x-content-type-options"]).toBe("nosniff");
    const gz = await raw(port, "GET", `/assets/${ASSET}`, "Accept-Encoding: gzip, br\r\n");
    expect(gz.status).toBe(200);
    expect(gz.headers["x-content-type-options"]).toBe("nosniff");
    expect(gz.headers["cache-control"]).toContain("immutable");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("%s on an existing asset goes to the app, never the file", async (method) => {
    const res = await raw(port, method, `/assets/${ASSET}`, "Content-Length: 0\r\n");
    expect(res.headers["x-from"]).toBe("app");
    expect(res.body).not.toContain(MARK.asset);
  });

  it("a missing asset and files of dist/client outside /assets/ go to the app", async () => {
    for (const path of ["/assets/khong-ton-tai.js", "/robots.txt", "/assets/", "/assets"]) {
      const res = await raw(port, "GET", path);
      expect(res.headers["x-from"], path).toBe("app");
      expect(res.body, path).not.toContain(MARK.robots);
    }
  });

  it.each([
    "/assets/../server/server.js",
    "/assets/../../package.json",
    "/assets/../../serve.mjs",
    "/assets/%2e%2e/%2e%2e/server/server.js",
    "/assets/%2E%2E/%2E%2E/package.json",
    "/assets/..%2f..%2fserver%2fserver.js",
    "/assets/..%2F..%2Fpackage.json",
    "/assets/%252e%252e/%252e%252e/package.json",
    "/assets/..\\..\\server\\server.js",
    "/assets/..%5c..%5cserver%5cserver.js",
    "/assets/..%5c..%5cpackage.json",
    `/assets/${ASSET}%00.txt`,
    "/assets/%00../../package.json",
    "//assets/../../package.json",
    "/assets//../../server/server.js",
    "/assets/./../../package.json",
    "/assets/x/../../../server/server.js",
    "/server/server.js",
    "/package.json",
    "/serve.mjs",
    "http://127.0.0.1/assets/../../package.json",
  ])("traversal %s never serves the server bundle, package.json or serve.mjs", async (path) => {
    const res = await raw(port, "GET", path);
    expect(res.status).not.toBe(-1);
    expect(res.body).not.toContain(MARK.server);
    expect(res.body).not.toContain(MARK.pkg);
    expect(res.body).not.toContain("serveStatic");
    if (res.status === 200) expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});

/** Send a GET, wait for the first body byte (past the header block), then destroy the socket. */
function abortAfterFirstByte(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (gotBody: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(gotBody);
    };
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      const split = buf.indexOf("\r\n\r\n");
      if (split >= 0 && buf.length > split + 4) finish(true);
    });
    sock.on("error", () => finish(false));
    sock.on("close", () => finish(false));
    sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
  });
}

// DEBT-679 (run 93, D93.1): run 92 only fixed the static assets. App and BFF responses are web streams
// too (SSR, `fetch()` passthrough of an upstream body); a client leaving mid-body, or the stream itself
// failing mid-body, must not kill the process (uncaught ERR_INVALID_STATE as in run 92).
// The mid-body cases use a raw socket (close after the first body byte), not curl as D93.1 says: curl
// reads to the end. That probe does NOT hit the run 92 class (close right after the LAST byte while a
// read is pending), so the curl case below covers it for a finite, fast app stream.
describe("serve.mjs app response streams", () => {
  it.each([
    ["slow large app stream, client closes after the first byte", "/slow-stream"],
    ["BFF passthrough of a slow upstream fetch() body, client closes after the first byte", "/proxy"],
    ["app stream errors mid-body (controller.error)", "/error-stream"],
  ])("%s => process alive, no ERR_INVALID_STATE, next /healthz 200", async (_name, path) => {
    for (let i = 0; i < 3; i++) expect(await abortAfterFirstByte(path), path).toBe(true);
    await new Promise((r) => setTimeout(r, 600));
    expect(server.child.exitCode, server.log.text).toBeNull();
    expect(server.log.text).not.toContain("ERR_INVALID_STATE");
    expect((await raw(port, "GET", "/healthz")).status).toBe(200);
  }, 20_000);

  it("curl fetching a fast finite app stream (~600 KB) => 200, process alive, next /healthz 200", async () => {
    for (let i = 0; i < 3; i++) {
      const { stdout } = await execFileP("curl", ["-sS", "-o", devNull, "-w", "%{http_code}", `http://127.0.0.1:${port}/fast-stream`]);
      expect(stdout).toBe("200");
    }
    await new Promise((r) => setTimeout(r, 600));
    expect(server.child.exitCode, server.log.text).toBeNull();
    expect(server.log.text).not.toContain("ERR_INVALID_STATE");
    expect((await raw(port, "GET", "/healthz")).status).toBe(200);
  }, 30_000);
});

describe("serve.mjs boot", () => {
  it("self-check fails => exit 1 with a fixed message, no env value printed", async () => {
    const canary = randomBytes(30).toString("base64url");
    const broken = start(await freePort(), { FIXTURE_BROKEN: "1", OIDC_CLIENT_SECRET: canary, SESSION_SECRET: canary });
    const timeout = setTimeout(() => broken.child.kill(), 15_000);
    const code = await broken.exited;
    clearTimeout(timeout);
    expect(code).toBe(1);
    expect(broken.log.text).toContain("fe-admin: startup self-check failed");
    expect(broken.log.text).not.toContain(canary);
  }, 20_000);

  // DEBT-384 (run 53b): srvx swallows the listen error; without the ready() check the process ended
  // with code 0 and no log, so `restart: on-failure` never restarted it.
  it("port already in use => exit 1 with the error code, not a silent exit 0", async () => {
    const second = start(port);
    const timeout = setTimeout(() => second.child.kill(), 15_000);
    const code = await second.exited;
    clearTimeout(timeout);
    expect(code).toBe(1);
    expect(second.log.text).toContain("fe-admin: listen failed: EADDRINUSE");
    expect((await raw(port, "GET", "/healthz")).status).toBe(200); // the first server is untouched
  }, 20_000);

  it("/healthz needs no dependency: 200 `ok` on GET and HEAD", async () => {
    const get = await raw(port, "GET", "/healthz");
    expect(get.status).toBe(200);
    expect(get.body).toMatch(/^(ok|2\r\nok\r\n0\r\n\r\n)$/); // raw socket: plain or chunked framing
    expect((await raw(port, "HEAD", "/healthz")).status).toBe(200);
  });
});
