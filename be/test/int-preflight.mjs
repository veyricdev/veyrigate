import net from 'node:net';
import process from 'node:process';
import { URL } from 'node:url';

/**
 * Jest globalSetup for `test:int` (DEBT-070).
 *
 * Fail fast when the integration dependencies are not reachable. Without this
 * probe a missing `vg-test-mongo` / `vg-test-redis` makes ioredis retry and
 * mongoose block until their long timeouts, so the suite appears to hang for
 * ~10 minutes before failing with an opaque error. Here we TCP-probe both
 * ports in parallel with a short timeout and throw an actionable message.
 *
 * Attached ONLY via the `--globalSetup` flag in the `test:int` script, so plain
 * `pnpm test` (unit) never runs it. Pure JS (.mjs) to avoid ts-jest transform.
 */

const PROBE_TIMEOUT_MS = 2000;

/**
 * Resolve host/port from an override URI (e.g. `TEST_MONGO_URI`) so the probe
 * targets the same endpoint the int-specs connect to; fall back to the default
 * local test container. A malformed override falls back rather than crashing.
 */
function resolveTarget(name, uri, defaultHost, defaultPort) {
  if (uri) {
    try {
      const url = new URL(uri);
      if (url.hostname) {
        return { name, host: url.hostname, port: Number(url.port) || defaultPort };
      }
    } catch {
      // Ignore malformed override and use the default below.
    }
  }
  return { name, host: defaultHost, port: defaultPort };
}

const DEPENDENCIES = [
  resolveTarget('vg-test-mongo', process.env.TEST_MONGO_URI, 'localhost', 27117),
  resolveTarget('vg-test-redis', process.env.TEST_REDIS_URL, 'localhost', 6479),
];

function probe({ name, host, port }) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (reachable) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve({ name, host, port, reachable });
    };
    // Don't keep the event loop alive once the probe result is known.
    socket.unref();
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

export default async function intPreflight() {
  const results = await Promise.all(DEPENDENCIES.map(probe));
  const down = results.filter((r) => !r.reachable);
  if (down.length > 0) {
    const missing = down.map((d) => `${d.name} (${d.host}:${d.port})`).join(', ');
    throw new Error(
      `Integration test dependencies not reachable: ${missing}.\n` +
        `Start the test containers first:\n\n` +
        `  docker start vg-test-mongo vg-test-redis\n`,
    );
  }
}
