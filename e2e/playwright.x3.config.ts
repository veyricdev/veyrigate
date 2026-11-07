import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { ISSUER } from "./config/env";
import { X3_BE_PORT, X3_RPS, X3_TLS_PORT, x3BeEnv, x3RpEnv, type X3Rp } from "./x3/env";

const e2eDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(e2eDir, "..");
const feDir = resolve(repoRoot, "fe-sso-test");

/**
 * X3 cookie topology × browser matrix (run 73, plan X3, spec §9.6). Separate from the default
 * config so `pnpm -C e2e e2e` keeps its 37 tests and speed. Never run both at once: they share the
 * `sso-idp-e2e` DB/seed and the X3 BE re-seeds the demo resource identifiers for its https issuer.
 *
 * Servers (all health-gated, all stopped by Playwright when the run ends):
 *  - BE :4100 — same build/assert/sync/seed chain as the default config, env `x3BeEnv()`
 *    (`ISSUER=https://idp.alpha.localhost:8443`, `SESSION_COOKIE_SECURE=true`, `E2E_X3=1`).
 *  - fe-sso-test ×2 — Vite on 127.0.0.1:5273 (`x3-alpha`) / :5274 (`x3-beta`), spawned with `node`.
 *  - TLS front :8443 — `x3/tls-proxy.mjs` (127.0.0.1 only, self-signed cert made at start).
 *
 * `trace: off` everywhere (traces record `fill()` values and cookie values).
 */
/**
 * `seed:e2e-admin` runs with the DEFAULT issuer: its `admin` resource is insert-only and refuses to
 * be re-pointed from `http://localhost:4000/admin/` (default suite) to the X3 issuer. X3 does not use
 * the admin API; only `x3-alpha`/`x3-beta` (issuer-independent) matter here. Its bootstrap also
 * re-runs seedDev with that issuer, so `db:seed-dev` runs AFTER it with the X3 issuer: `/demo/me`
 * pins `aud` to `<issuer>/demo/` (the default suite re-seeds the identifiers back).
 */
const seedE2eAdmin = `node -e "process.env.ISSUER='${ISSUER}';require('node:child_process').execSync('pnpm -C be seed:e2e-admin',{stdio:'inherit'})"`;

const vite = (rp: X3Rp) => ({
  command: `node node_modules/vite/bin/vite.js --port ${rp.vitePort} --strictPort --host 127.0.0.1`,
  cwd: feDir,
  url: `http://127.0.0.1:${rp.vitePort}/`,
  timeout: 120_000,
  reuseExistingServer: false,
  stdout: "pipe" as const,
  stderr: "pipe" as const,
  env: x3RpEnv(rp),
});

export default defineConfig({
  testDir: "./x3",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  timeout: 120_000,
  reporter: [["list"]],
  use: {
    ignoreHTTPSErrors: true,
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], ignoreHTTPSErrors: true } },
    { name: "firefox", use: { ...devices["Desktop Firefox"], ignoreHTTPSErrors: true } },
    { name: "webkit", use: { ...devices["Desktop Safari"], ignoreHTTPSErrors: true } },
  ],
  webServer: [
    {
      command:
        "pnpm -C be build && node be/test/e2e/assert-dist-clean.mjs && pnpm -C be db:sync-indexes && " +
        `${seedE2eAdmin} && pnpm -C be db:seed-dev && pnpm -C be start:e2e`,
      cwd: repoRoot,
      url: `http://127.0.0.1:${X3_BE_PORT}/ready`,
      timeout: 320_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
      env: x3BeEnv(),
    },
    vite(X3_RPS.alpha),
    vite(X3_RPS.beta),
    {
      command: "node x3/tls-proxy.mjs",
      cwd: e2eDir,
      url: `https://127.0.0.1:${X3_TLS_PORT}/__x3_health`,
      ignoreHTTPSErrors: true,
      timeout: 30_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
