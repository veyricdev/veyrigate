import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { beEnv, feAdminEnv, feEnv, BE_PORT, FE_ADMIN_URL, FE_PORT } from "./config/env";

/** Repo root (one level above this `e2e/` package) — webServer `pnpm -C <pkg>` resolves from here. */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Playwright config for the X1 walking-skeleton E2E (plan §8 X1). One Chromium project; multi-
 * browser is deferred to X3. Two `webServer`s are started and health-gated before the suite:
 *
 *  - BE (:4000): build → assert `dist` holds no E2E-only code (INV-23) → sync indexes → seed dev
 *    client/resource/user → seed the E2E admin + known `fe-admin` secret (run 39) → run the E2E entry `be/test/e2e/e2e-main.ts` (same AppModule +
 *    `configureApp` as `main.ts`, Google replaced by an in-process mock on 127.0.0.1, run 33 X4).
 *    Ready only when `GET /ready` returns 200 (Mongo + Redis both up). Probed on
 *    `127.0.0.1` because BE listens on `0.0.0.0` (IPv4) and `localhost` may resolve to `::1`.
 *  - FE (:5173): the fe-sso-test Vite dev server (strictPort). Ready on `GET /`.
 *  - fe-admin (:3000, run 42): the admin BFF dev server (strictPort). Ready on `GET /` (the guard
 *    answers a redirect to the login route; no cookie => no Redis or IdP call, so the probe has no
 *    side effect).
 *
 * All BE/FE env is injected via `webServer.env` (hermetic: never reads the real `be/.env`, which
 * BE loads non-overriding). `reuseExistingServer` is opt-in via `E2E_REUSE=1` (then the running
 * servers' own env is used — see README). Traces record `fill()` values, so they are only enabled
 * on CI (`retain-on-failure`, credential is a non-secret CI placeholder) and off locally.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  // Run 92 (D92.5) fuses, CI only: a systemic failure (every sign-in stuck at /login/mfa) used to run
  // each test to its own 90-240 s timeout until the 6 h job limit. Locally every failure is listed.
  ...(process.env.CI ? { maxFailures: 5, globalTimeout: 45 * 60_000 } : {}),
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://localhost:${FE_PORT}`,
    trace: process.env.CI ? "retain-on-failure" : "off",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // DEBT-678 (run 92): each long-running server is started with `node` directly, not through
  // `pnpm run`. On Linux Playwright stops a webServer by SIGKILL to its process group and then waits,
  // with no timeout, for the stdout/stderr pipes to close. CI #47 hung there ("teardown for plugin
  // setup" until globalTimeout); pnpm 12 forwards termination signals to its script (12.6.0
  // changelog), so the script presumably runs outside the group and outlives a SIGKILLed pnpm,
  // holding the pipe. Started with `node`, the server is in the killed group (Windows: taskkill /T).
  // One-shot steps before the server still use pnpm (they have exited by then).
  // The pnpm process-group mechanism is a HYPOTHESIS (pnpm 12.6.0 changelog), not proven. Confirmation
  // criterion: with DEBUG=pw:webserver, 3 `Terminated the WebServer` lines (one per server; CI #48).
  webServer: [
    {
      // Build once, prove dist is clean, sync indexes, seed, then run the E2E entry (mock Google).
      command:
        "pnpm -C be build && node be/test/e2e/assert-dist-clean.mjs && pnpm -C be db:sync-indexes && pnpm -C be db:seed-dev && pnpm -C be seed:e2e-admin && cd be && node node_modules/ts-node/dist/bin.js test/e2e/e2e-main.ts",
      cwd: repoRoot,
      url: `http://127.0.0.1:${BE_PORT}/ready`,
      // DEBT-464 (run 68): 68.5 s idle, 104 s under a 28-thread CPU load (build ~34-38 s,
      // start:e2e ~41 s, seed:e2e-admin ~20 s) => >= 3x the max under load.
      timeout: 320_000,
      reuseExistingServer: process.env.E2E_REUSE === "1",
      stdout: "pipe",
      stderr: "pipe",
      env: beEnv(),
    },
    {
      command: "node node_modules/vite/bin/vite.js",
      cwd: resolve(repoRoot, "fe-sso-test"),
      url: `http://localhost:${FE_PORT}/`,
      timeout: 120_000,
      reuseExistingServer: process.env.E2E_REUSE === "1",
      stdout: "pipe",
      stderr: "pipe",
      env: feEnv(),
    },
    {
      command: "node node_modules/vite/bin/vite.js dev",
      cwd: resolve(repoRoot, "fe-admin"),
      url: `${FE_ADMIN_URL}/`,
      timeout: 120_000,
      reuseExistingServer: process.env.E2E_REUSE === "1",
      stdout: "pipe",
      stderr: "pipe",
      env: feAdminEnv(),
    },
  ],
});
