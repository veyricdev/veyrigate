// @vitest-environment node
// Tester (run 41): check:bundle in a throw-away copy (real script + real env.ts, fake dist/client),
// so the scanner is exercised on planted leaks without touching the real build output.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const pkg = fileURLToPath(new URL("..", import.meta.url));
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "check-bundle-"));
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "src", "server"), { recursive: true });
  cpSync(join(pkg, "scripts", "check-bundle.mjs"), join(dir, "scripts", "check-bundle.mjs"));
  cpSync(join(pkg, "src", "server", "env.ts"), join(dir, "src", "server", "env.ts"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function client(files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    const file = join(dir, "dist", "client", name);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
  }
}
function run(canaries?: string) {
  const env = { ...process.env };
  delete env.BUNDLE_CANARIES;
  if (canaries !== undefined) env.BUNDLE_CANARIES = canaries;
  const r = spawnSync(process.execPath, [join(dir, "scripts", "check-bundle.mjs")], { env, encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe("check:bundle", () => {
  it("passes a clean client bundle and reports what it scanned", () => {
    client({ "assets/index.js": "console.log('hello')", "assets/index.css": "body{}" });
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/scanned 2 client files for 7 server env names \+ 0 canaries: 0 hit/);
  });

  it.each([
    "OIDC_ISSUER",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "SESSION_SECRET",
    "ADMIN_API_BASE_URL",
    "ADMIN_API_RESOURCE",
    "APP_URL",
  ])("fails when a nested client asset contains %s", (name) => {
    client({ "assets/index.js": "x", "assets/deep/chunk.js": `const k="${name}"` });
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain(name);
  });

  it("fails on a canary value and reports it by index, never by value", () => {
    const secret = "canary-secret-value-0123456789abcdef";
    client({ "assets/index.js": `var s=${JSON.stringify(secret)}` });
    const r = run(`other-canary-not-present,${secret}`);
    expect(r.code).toBe(1);
    expect(r.out).toContain("canary #2");
    expect(r.out).not.toContain(secret);
    expect(r.out).not.toContain("other-canary-not-present");
  });

  it("ignores empty entries in BUNDLE_CANARIES (no match-everything needle)", () => {
    client({ "assets/index.js": "x" });
    const r = run(",,");
    expect(r.code).toBe(0);
    expect(r.out).toContain("+ 0 canaries");
  });

  it("refuses to pass when dist/client is missing", () => {
    expect(run().code).not.toBe(0);
  });

  it("refuses to pass when dist/client is empty", () => {
    mkdirSync(join(dir, "dist", "client"), { recursive: true });
    const r = run();
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("is empty");
  });

  it("refuses to pass when no env names can be parsed", () => {
    writeFileSync(join(dir, "src", "server", "env.ts"), "export {}\n");
    client({ "assets/index.js": "x" });
    const r = run();
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("no server env names parsed");
  });
});
