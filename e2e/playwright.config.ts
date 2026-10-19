import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { beEnv, feEnv, BE_PORT, FE_PORT } from "./config/env";

/** Repo root (one level above this `e2e/` package) — webServer `pnpm -C <pkg>` resolves from here. */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Playwright config for the X1 walking-skeleton E2E (plan §8 X1). One Chromium project; multi-
 * browser is deferred to X3. Two `webServer`s are started and health-gated before the suite:
 *
 *  - BE (:4000): build → assert `dist` holds no E2E-only code (INV-23) → sync indexes → seed dev
 *    client/resource/user → run the E2E entry `be/test/e2e/e2e-main.ts` (same AppModule +
 *    `configureApp` as `main.ts`, Google replaced by an in-process mock on 127.0.0.1, run 33 X4).
 *    Ready only when `GET /ready` returns 200 (Mongo + Redis both up). Probed on
 *    `127.0.0.1` because BE listens on `0.0.0.0` (IPv4) and `localhost` may resolve to `::1`.
 *  - FE (:5173): the fe-sso-test Vite dev server (strictPort). Ready on `GET /`.
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
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://localhost:${FE_PORT}`,
    trace: process.env.CI ? "retain-on-failure" : "off",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // Build once, prove dist is clean, sync indexes, seed, then run the E2E entry (mock Google).
      command:
        "pnpm -C be build && node be/test/e2e/assert-dist-clean.mjs && pnpm -C be db:sync-indexes && pnpm -C be db:seed-dev && pnpm -C be start:e2e",
      cwd: repoRoot,
      url: `http://127.0.0.1:${BE_PORT}/ready`,
      timeout: 120_000,
      reuseExistingServer: process.env.E2E_REUSE === "1",
      stdout: "pipe",
      stderr: "pipe",
      env: beEnv(),
    },
    {
      command: "pnpm -C fe-sso-test dev",
      cwd: repoRoot,
      url: `http://localhost:${FE_PORT}/`,
      timeout: 120_000,
      reuseExistingServer: process.env.E2E_REUSE === "1",
      stdout: "pipe",
      stderr: "pipe",
      env: feEnv(),
    },
  ],
});
