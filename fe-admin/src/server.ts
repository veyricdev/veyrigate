// Server entry (Start convention: src/server.ts). Validates server env once at startup, before any
// request is served: a misconfigured server answers every request with a bare 500 (details are in
// the server log, names only) instead of rendering pages without its secrets.
// Outermost: security headers + CSP nonce (A7) on every response, the 500 and the 503 included.
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { rejectBody } from "./server/body-limit";
import { serverEnv } from "./server/env";
import { withSecurityHeaders } from "./server/security-headers";
import { withUnavailableStatus } from "./server/unavailable";

let envValid = true;
let site: { appUrl?: string; issuer?: string } = {};
try {
  const env = serverEnv();
  site = { appUrl: env.APP_URL, issuer: env.OIDC_ISSUER };
} catch {
  envValid = false; // already logged by onValidationError
}

export default createServerEntry({
  fetch(request, opts) {
    return withSecurityHeaders(() => {
      if (!envValid) {
        return new Response("Internal Server Error", {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      const { pathname } = new URL(request.url);
      // Liveness only (run 52): no Redis/IdP/session, no version; Redis/IdP down => 503 per request.
      if ((request.method === "GET" || request.method === "HEAD") && pathname === "/healthz") {
        return new Response("ok", {
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        });
      }
      // Existing assets are served by the host (serve.mjs); a miss is a plain 404, not the root
      // guard's login redirect (a stale chunk would otherwise load the login HTML as a script).
      if (pathname.startsWith("/assets/")) {
        return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      const refused = rejectBody(request); // DEBT-370: before the router parses anything
      if (refused) return refused;
      return withUnavailableStatus(() => handler.fetch(request, opts));
    }, site);
  },
});
