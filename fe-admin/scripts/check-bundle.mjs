// Fails if any client asset contains a server env variable name (taken from src/server/env.ts) or
// one of the canary strings in BUNDLE_CANARIES (comma-separated, e.g. the secret values used for a
// build). Run after `vite build`; Start 1.168.60 writes client assets to dist/client.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const clientDir = join(root, "dist", "client");
const envSource = readFileSync(join(root, "src", "server", "env.ts"), "utf8");

const names = [...envSource.matchAll(/^\s{4}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]);
if (names.length === 0) throw new Error("check:bundle: no server env names parsed from env.ts");
const canaries = (process.env.BUNDLE_CANARIES ?? "").split(",").filter(Boolean);
const needles = [...names, ...canaries];

if (!existsSync(clientDir)) throw new Error(`check:bundle: ${clientDir} missing, run build first`);

const files = readdirSync(clientDir, { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile())
  .map((d) => join(d.parentPath, d.name));
if (files.length === 0) throw new Error(`check:bundle: ${clientDir} is empty, run build first`);

const hits = [];
for (const file of files) {
  const text = readFileSync(file, "latin1");
  needles.forEach((needle, i) => {
    // Report canaries by index so the secret value itself is never printed.
    if (text.includes(needle)) hits.push(`${file}: ${i < names.length ? needle : `canary #${i - names.length + 1}`}`);
  });
}

console.log(
  `check:bundle scanned ${files.length} client files for ${names.length} server env names + ${canaries.length} canaries: ${hits.length} hit(s)`,
);
if (hits.length) {
  console.error(hits.join("\n"));
  process.exit(1);
}
