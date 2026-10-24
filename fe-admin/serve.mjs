// Production entry of the fe-admin BFF (run 52, A9): `node serve.mjs` after `vite build`.
// - `dist/server/server.js` is a Web Fetch handler (`export default { fetch }`) that opens no port;
//   srvx's programmatic API serves it on HOST/PORT (srvx defaults). Its CLI is not used: it loads
//   `.env` files from the cwd and serves static files before the app, without our headers.
// - No `.env` is read here (no dotenv, no --env-file): configuration comes from the process env only.
// - Trust proxy stays off: absolute URLs are built from APP_URL, never from Host/X-Forwarded-*.
import { fileURLToPath } from "node:url";
import { serve } from "srvx";
import { serveStatic } from "srvx/static";

const app = (await import("./dist/server/server.js")).default;

// Boot self-check: with an invalid env the app answers 500 to everything (names already logged by
// the env validation), so exit instead of living on broken. No env value is printed.
const check = await app.fetch(new Request("http://localhost/healthz"));
if (check.status !== 200) {
  console.error("fe-admin: startup self-check failed (see errors above)");
  process.exit(1);
}

// Only the hashed client assets, only from dist/client (never dist/ or dist/server). A miss goes on
// to the app, whose 404 carries the A7 headers.
const statics = serveStatic({ dir: fileURLToPath(new URL("./dist/client", import.meta.url)) });

async function assets(request, next) {
  if (request.method !== "GET" && request.method !== "HEAD") return next();
  if (!new URL(request.url).pathname.startsWith("/assets/")) return next();
  const found = await statics(request, () => undefined);
  if (!found) return next();
  const headers = new Headers(found.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(found.body, { status: found.status, headers });
}

const server = serve({ fetch: app.fetch, gracefulShutdown: true, middleware: [assets] });
// srvx swallows a listen error (EADDRINUSE, EACCES on a port < 1024 as uid 1000) and the process would
// then end with code 0 and no log: fail loudly instead, so the orchestrator restarts it (DEBT-384).
await server.ready().catch((error) => {
  console.error(`fe-admin: listen failed: ${error.code ?? error.name}`);
  process.exit(1);
});
// srvx closes the HTTP server on SIGTERM/SIGINT (graceful, 5 s). Then exit: the session Redis client
// (reconnect timers) would otherwise keep the process alive until the container is killed.
server.node.server.once("close", () => process.exit(0));
