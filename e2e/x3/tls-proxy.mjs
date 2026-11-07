// X3 local TLS front (run 73). Node built-ins only. Listens on 127.0.0.1:8443 ONLY and routes by
// `Host` to the plain-http servers of the X3 stack (see x3/env.ts). The certificate is self-signed,
// generated at start by `openssl` into `e2e/.x3-tls/` (git-ignored, regenerated every run, valid
// 2 days); it is never installed in any trust store — browsers use `ignoreHTTPSErrors`.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { request } from "node:http";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 8443;
const ROUTES = {
  "idp.alpha.localhost": 4100,
  "app.alpha.localhost": 5273,
  "app.beta.localhost": 5274,
};

const ECHO_ORIGINS = new Set([`https://app.alpha.localhost:${PORT}`, `https://app.beta.localhost:${PORT}`]);

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".x3-tls");
mkdirSync(dir, { recursive: true });
const keyPath = resolve(dir, "key.pem");
const certPath = resolve(dir, "cert.pem");
const gen = spawnSync(
  "openssl",
  [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2",
    "-keyout", keyPath, "-out", certPath,
    "-subj", "/CN=x3.localhost",
    "-addext", "subjectAltName=DNS:*.alpha.localhost,DNS:*.beta.localhost,IP:127.0.0.1",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
if (gen.error || gen.status !== 0) {
  console.error(
    "x3 tls-proxy: `openssl` is required to generate the self-signed X3 certificate " +
      "(run from Git Bash or put openssl on PATH).",
    gen.error?.message ?? gen.stderr?.toString(),
  );
  process.exit(1);
}

/** Upstream port for a `Host` header, or undefined (unknown hosts are refused). */
function upstream(host) {
  return ROUTES[(host ?? "").replace(/:\d+$/, "").toLowerCase()];
}

const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req, res) => {
  if (req.url === "/__x3_health") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }
  const port = upstream(req.headers.host);
  // Test-only probe on the IdP host: the NAMES of the cookies the browser sent with a credentialed
  // cross-origin fetch (a failed CORS request exposes no `cookie` header to Playwright).
  if (port === ROUTES["idp.alpha.localhost"] && req.url === "/__x3_echo") {
    const origin = req.headers.origin;
    const names = (req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")[0]).filter(Boolean).sort();
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(ECHO_ORIGINS.has(origin) ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "Origin" } : {}),
    });
    return res.end(JSON.stringify(names));
  }
  if (!port) {
    res.writeHead(421, { "content-type": "text/plain" });
    return res.end("unknown host");
  }
  const up = request(
    { host: "127.0.0.1", port, method: req.method, path: req.url, headers: req.headers },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    },
  );
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("bad gateway");
  });
  req.pipe(up);
});

// WebSocket upgrades (Vite HMR): raw byte tunnel to the same upstream.
server.on("upgrade", (req, socket, head) => {
  const port = upstream(req.headers.host);
  if (!port) return socket.destroy();
  const up = connect(port, "127.0.0.1", () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    up.write(lines.join("\r\n") + "\r\n\r\n");
    up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

server.listen(PORT, "127.0.0.1", () => console.log(`x3 tls-proxy on https://127.0.0.1:${PORT}`));
