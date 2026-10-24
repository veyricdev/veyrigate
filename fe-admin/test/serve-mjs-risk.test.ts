// @vitest-environment node
// Run 52 (tester): the real `serve.mjs` (srvx host of the production build) run as a child process
// against a fixture build, so no `vite build` and no Docker are needed. Raw HTTP over a socket keeps
// paths byte-exact (no client normalisation): traversal must never reach `dist/server`, the fixture
// root (`package.json`, `serve.mjs`) or files outside `dist/client/assets`; only GET/HEAD are served
// as assets, with nosniff + immutable; a failing boot self-check exits 1 without printing env values.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const FE_ADMIN = fileURLToPath(new URL("..", import.meta.url));
// Under fe-admin/node_modules (gitignored): `srvx` resolves from fe-admin/node_modules as in the image.
const ROOT = `${FE_ADMIN}node_modules/.cache/serve-mjs-risk-${process.pid}-${randomBytes(4).toString("hex")}`;
const ASSET = "app-Ab12Cd34.js";
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

beforeAll(async () => {
  writeFixture();
  port = await freePort();
  server = start(port);
  expect(await ready(port, server.child), server.log.text).toBe(true);
}, 30_000);

afterAll(async () => {
  if (server?.child.exitCode === null) {
    server.child.kill();
    await server.exited;
  }
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

  it("/healthz needs no dependency: 200 `ok` on GET and HEAD", async () => {
    const get = await raw(port, "GET", "/healthz");
    expect(get.status).toBe(200);
    expect(get.body).toMatch(/^(ok|2\r\nok\r\n0\r\n\r\n)$/); // raw socket: plain or chunked framing
    expect((await raw(port, "HEAD", "/healthz")).status).toBe(200);
  });
});
