// F20 (run 33, INV-23): fail if test-only federation wiring leaked into the production build.
// Run after `pnpm -C be build`, before the E2E server starts. Scans every file under be/dist/.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { exit, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const MARKERS = ['__E2E_MOCK_PROVIDER__', 'e2e-main'];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

const leaks = [];
for (const file of walk(dist)) {
  const rel = relative(dist, file);
  const text = readFileSync(file, 'latin1');
  if (MARKERS.some((m) => rel.includes(m) || text.includes(m))) leaks.push(rel);
}
if (leaks.length > 0) {
  stderr.write(`be/dist contains E2E-only code (INV-23): ${leaks.join(', ')}\n`);
  exit(1);
}
stdout.write('be/dist clean: no E2E mock provider wiring\n');
