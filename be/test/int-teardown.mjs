import console from 'node:console';
import { clearInterval } from 'node:timers';
import { LOCK_KEY } from './int-preflight.mjs';

/**
 * Jest globalTeardown for `test:int` (DEBT-201): release the single-run lock
 * taken in int-preflight.mjs. Deletes the key only if it still holds our token
 * (value compare), so an expired-and-retaken lock of another run is untouched.
 * Redis errors here only warn: the lock then expires on its own TTL.
 */
const RELEASE_LUA =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

export default async function intTeardown() {
  const lock = globalThis.__VG_INT_LOCK__;
  if (!lock) return;
  globalThis.__VG_INT_LOCK__ = undefined;
  clearInterval(lock.heartbeat);
  try {
    await lock.redis.eval(RELEASE_LUA, 1, LOCK_KEY, lock.token);
    await lock.redis.quit();
  } catch (err) {
    console.warn(`[int-teardown] could not release ${LOCK_KEY}: ${err.message}`);
    lock.redis.disconnect();
  }
}
