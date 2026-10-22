// Refreshes the committed admin OpenAPI snapshot (D11, run 43 F1) from a running BE in
// development/test mode (the route is not served in production). No `.env`, no token: the document
// is public in those modes. Then run `pnpm -C fe-admin gen:api` to regenerate the request types.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const base = (process.env.ADMIN_OPENAPI_URL || "http://127.0.0.1:4000").replace(/\/+$/, "");
const res = await fetch(`${base}/openapi/admin.json`, { signal: AbortSignal.timeout(10_000) });
if (!res.ok) throw new Error(`fetch:api: GET ${base}/openapi/admin.json -> HTTP ${res.status}`);
const doc = await res.json();
const out = fileURLToPath(new URL("../openapi/admin.json", import.meta.url));
writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
console.log(`fetch:api: wrote ${out} (${Object.keys(doc.paths ?? {}).length} paths)`);
