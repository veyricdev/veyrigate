import console from 'node:console';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import process from 'node:process';
import { setInterval } from 'node:timers';
import { URL } from 'node:url';
import Redis from 'ioredis';

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

// Single-run lock (DEBT-201): two concurrent `test:int` runs share vg-test-redis
// and the 127.0.0.1 rate-limit buckets, so they corrupt each other. Only this
// key is touched — never FLUSH, never other keys. Released by int-teardown.mjs.
export const LOCK_KEY = 'vg:int-lock';
const LOCK_TTL_MS = 120_000;
const HEARTBEAT_MS = 30_000;
// Extend only while we still hold the lock (value compare), so a stale run can
// never extend a lock that expired and was taken by someone else.
const EXTEND_LUA =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end";

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
  await acquireLock();
}

async function acquireLock() {
  const redis = new Redis(process.env.TEST_REDIS_URL ?? 'redis://localhost:6479', {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: PROBE_TIMEOUT_MS,
  });
  const token = `${os.hostname()}:${process.pid}:${randomUUID()}`;
  try {
    await redis.connect();
    const ok = await redis.set(LOCK_KEY, token, 'PX', LOCK_TTL_MS, 'NX');
    if (ok !== 'OK') {
      const [holder, ttl] = await Promise.all([redis.get(LOCK_KEY), redis.pttl(LOCK_KEY)]);
      throw new Error(
        `another test:int is running (holder=${holder}, ttl=${ttl}ms); ` +
          `if stale: docker exec vg-test-redis redis-cli DEL ${LOCK_KEY}`,
      );
    }
  } catch (err) {
    redis.disconnect();
    throw err;
  }
  const heartbeat = setInterval(() => {
    redis.eval(EXTEND_LUA, 1, LOCK_KEY, token, LOCK_TTL_MS).catch((err) => {
      console.warn(`[int-preflight] lock heartbeat failed: ${err.message}`);
    });
  }, HEARTBEAT_MS);
  heartbeat.unref();
  globalThis.__VG_INT_LOCK__ = { redis, token, heartbeat };
}
