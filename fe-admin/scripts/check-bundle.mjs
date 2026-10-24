// Fails if any client asset contains a server env variable name (taken from src/server/env.ts) or
// one of the canary strings in BUNDLE_CANARIES (comma-separated, e.g. the secret values used for a
// build). Run after `vite build`; Start 1.168.60 writes client assets to dist/client.
// DEBT-366: it also evaluates every client JS chunk with `Function`/`eval` wrapped and fails on any
// call at load (the CSP has no 'unsafe-eval': zod's JIT probe at schema build is one) or on a chunk
// that cannot be evaluated (fail-closed).
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

let evalCalls = 0;
const counted = (fn) =>
  new Proxy(fn, {
    apply: (t, self, args) => (evalCalls++, Reflect.apply(t, self, args)),
    construct: (t, args, nt) => (evalCalls++, Reflect.construct(t, args, nt)),
  });
globalThis.Function = counted(Function);
globalThis.eval = counted(eval);
const chunks = files.filter((f) => f.endsWith(".js")).sort();
for (const file of chunks) {
  try {
    await import(pathToFileURL(file).href);
  } catch (err) {
    hits.push(`${file}: cannot be evaluated (${err?.name ?? typeof err})`);
  }
}
if (evalCalls) hits.push(`client chunks: ${evalCalls} Function/eval call(s) at load (CSP has no 'unsafe-eval')`);

console.log(
  `check:bundle scanned ${files.length} client files for ${names.length} server env names + ${canaries.length} canaries, evaluated ${chunks.length} chunks (${evalCalls} Function/eval call(s)): ${hits.length} hit(s)`,
);
if (hits.length) {
  console.error(hits.join("\n"));
  process.exit(1);
}
