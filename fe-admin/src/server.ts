// Server entry (Start convention: src/server.ts). Validates server env once at startup, before any
// request is served: a misconfigured server answers every request with a bare 500 (details are in
// the server log, names only) instead of rendering pages without its secrets.
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { serverEnv } from "./server/env";

let envValid = true;
try {
  serverEnv();
} catch {
  envValid = false; // already logged by onValidationError
}

export default createServerEntry({
  fetch(request, opts) {
    if (!envValid) {
      return new Response("Internal Server Error", {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return handler.fetch(request, opts);
  },
});
