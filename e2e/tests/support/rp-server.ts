import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { feEnv } from "../../config/env";

/**
 * A second fe-sso-test Vite dev server bound to a client created at test time (run 39 Task 2,
 * Q-39.2). The app reads `client_id` from `import.meta.env` at dev-server start, so a new client
 * needs its own server. The port is picked free at run time (the redirect URI is registered with
 * that exact port), then held with `--strictPort`. Vite is spawned directly with `node` (no pnpm /
 * shell wrapper) so `stop()` kills the real process tree, also on Windows.
 */

const feDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fe-sso-test");
const viteBin = resolve(feDir, "node_modules", "vite", "bin", "vite.js");

/** A TCP port that is free right now (bound on all interfaces, then released). */
export function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once("error", fail);
    srv.listen(0, () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === "object" && addr ? ok(addr.port) : fail(new Error("no port"))));
    });
  });
}

export interface RpServer {
  readonly origin: string;
  stop(): Promise<void>;
}

/** Start fe-sso-test on `port` as `clientId`; resolves once `GET /` answers 200 (≤ 30 s). */
export async function startRp(clientId: string, port: number): Promise<RpServer> {
  const origin = `http://localhost:${port}`;
  const child = spawn(process.execPath, [viteBin, "--port", String(port), "--strictPort"], {
    cwd: feDir,
    env: {
      ...process.env,
      ...feEnv(),
      VITE_OIDC_CLIENT_ID: clientId,
      VITE_OIDC_REDIRECT_URI: `${origin}/callback`,
      VITE_OIDC_POST_LOGOUT_URI: `${origin}/`,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  const keep = (d: Buffer) => (output = (output + d.toString()).slice(-2000));
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  const rp: RpServer = { origin, stop: () => stopChild(child) };

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      if ((await fetch(`${origin}/`)).status === 200) return rp;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  await rp.stop();
  throw new Error(`fe-sso-test RP on :${port} did not become ready:\n${output}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  if (process.platform === "win32") {
    // /T: also the esbuild service Vite started; /F: no console to receive a soft signal.
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
}
