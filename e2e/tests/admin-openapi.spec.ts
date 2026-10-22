import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { BE_PORT } from "../config/env";

/**
 * Contract drift guard for fe-admin (run 43 F1, D11): the admin OpenAPI served by the E2E BE
 * (`NODE_ENV=test`) must equal the snapshot fe-admin generates its request types from
 * (`fe-admin/openapi/admin.json`). No sign-in, no DB write.
 */
const snapshotPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "fe-admin", "openapi", "admin.json");

test("BE admin OpenAPI equals the fe-admin snapshot", async ({ request }) => {
  const res = await request.get(`http://127.0.0.1:${BE_PORT}/openapi/admin.json`);
  expect(res.status()).toBe(200);
  const live: unknown = await res.json();
  const snapshot: unknown = JSON.parse(readFileSync(snapshotPath, "utf8"));
  expect(
    live,
    "fe-admin/openapi/admin.json is stale. Update it with: pnpm -C fe-admin fetch:api && pnpm -C fe-admin gen:api",
  ).toEqual(snapshot);
});
