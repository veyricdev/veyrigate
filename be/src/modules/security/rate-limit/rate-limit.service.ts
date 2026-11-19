import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sha256 } from '../../../common/crypto/crypto.util';
import type { SecurityConfig } from '../../../config/configuration';
import { loadLuaScripts } from '../../../database/redis/lua-loader';
import { RedisService } from '../../../database/redis/redis.service';

/** Dimensions of one request (spec §6.3). Missing dimensions are skipped. */
export interface RateLimitSubject {
  ip?: string;
  account?: string;
  deviceId?: string;
}

export interface RateLimitRule {
  /** Bucket name, e.g. `login`. Separates counters between endpoints. */
  name: string;
  limit?: number;
  windowSec?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the most restrictive exceeded window resets (0 when allowed). */
  retryAfterSec: number;
  /** Dimensions that exceeded the limit. */
  exceeded: (keyof RateLimitSubject)[];
}

/**
 * Fixed-window counter per key. INCR and PEXPIRE run in one Lua script, so the
 * first hit always sets the TTL (no immortal counters under concurrency).
 * Returns a flat list [count1, pttl1, count2, pttl2, ...].
 */
const HIT_SCRIPT = {
  name: 'rateLimitHit', // numberOfKeys omitted → key count passed as first argument
  lua: `
local out = {}
for i, key in ipairs(KEYS) do
  local count = redis.call('INCR', key)
  if count == 1 then redis.call('PEXPIRE', key, ARGV[1]) end
  out[#out + 1] = count
  out[#out + 1] = redis.call('PTTL', key)
end
return out`,
};

/**
 * Atomic "reserve" for the client-auth failure limiter (DEBT-029/039, tech-lead retry-1 (a)).
 *
 * KEYS = the buckets to charge; ARGV = [limit_1 … limit_n, windowMs].
 * Step 1: read EVERY counter (nil → 0). If ANY is already `>= its limit`, the request is blocked —
 *   return `{1, maxPttl}` and increment NOTHING (so a request already blocked by the client bucket
 *   does not burn the IP bucket, and vice-versa).
 * Step 2: otherwise INCR every key, setting the TTL on the first hit of each (no immortal counters
 *   under concurrency). Return `{0, 0}`.
 *
 * Checking ALL keys before touching ANY is what closes the peek→hit race the senior found: there is
 * no window between "read" and "increment", so Argon2 runs at most `limit` times per window even
 * under unbounded concurrency.
 */
const RESERVE_SCRIPT = {
  name: 'rateLimitReserve', // numberOfKeys omitted → key count passed as first argument
  lua: `
local n = #KEYS
local windowMs = ARGV[n + 1]
local maxPttl = 0
for i = 1, n do
  local count = tonumber(redis.call('GET', KEYS[i]) or '0')
  if count >= tonumber(ARGV[i]) then
    local pttl = redis.call('PTTL', KEYS[i])
    if pttl > maxPttl then maxPttl = pttl end
  end
end
if maxPttl > 0 then
  return {1, maxPttl}
end
for i = 1, n do
  local count = redis.call('INCR', KEYS[i])
  if count == 1 then redis.call('PEXPIRE', KEYS[i], windowMs) end
end
return {0, 0}`,
};

/**
 * Give back a reservation on a SUCCESSFUL authentication (tech-lead retry-1 (a)): each key is
 * decremented only when it exists and is `> 0` (never re-creates a key, never goes negative, keeps
 * the existing TTL). A crashed process simply leaves its +1 to expire with the window.
 */
const REFUND_SCRIPT = {
  name: 'rateLimitRefund', // numberOfKeys omitted → key count passed as first argument
  lua: `
for i = 1, #KEYS do
  local count = tonumber(redis.call('GET', KEYS[i]) or '0')
  if count > 0 then redis.call('DECR', KEYS[i]) end
end
return 1`,
};

/**
 * Global client-auth failure cap per `client_id` (DEBT-072, D97.13/D97.14).
 *
 * KEYS = [gKey, okKey, logKey]; ARGV = [limit, windowMs].
 * - `okKey` exists (this source authenticated this client in the last 7 days) => exempt:
 *   `{0,0,0,0}`, nothing incremented (a botnet burning the cap cannot lock out a known RP source).
 * - `gKey >= limit` => blocked, nothing incremented: `{1, pttl, first, 0}`; `first` = 1 only for the
 *   first block of the window (`SET logKey NX PX pttl`), so the caller logs once per window.
 * - else INCR `gKey` (TTL on the first hit) => `{0,0,0,1}` (last = reserved: only this may be refunded).
 */
const RESERVE_GLOBAL_SCRIPT = {
  name: 'rateLimitReserveGlobal', // numberOfKeys omitted → key count passed as first argument
  lua: `
if redis.call('EXISTS', KEYS[2]) == 1 then
  return {0, 0, 0, 0}
end
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
if count >= tonumber(ARGV[1]) then
  local pttl = redis.call('PTTL', KEYS[1])
  if pttl < 1 then pttl = 1 end
  local first = redis.call('SET', KEYS[3], '1', 'NX', 'PX', pttl) and 1 or 0
  return {1, pttl, first, 0}
end
if redis.call('INCR', KEYS[1]) == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return {0, 0, 0, 1}`,
};

/**
 * A successful client auth (D97.14 step 6): mark the source trusted for `ARGV[1]` ms (`SET okKey 1
 * PX`) and, only when THIS request reserved a unit (`ARGV[2]` = '1'), give it back (DECR `gKey` when
 * > 0, like `REFUND_SCRIPT`). An exempt source never decrements: else its successes would erase the
 * botnet's failures and void the cap. KEYS = [gKey, okKey].
 */
const CLIENT_OK_SCRIPT = {
  name: 'rateLimitClientOk', // numberOfKeys omitted → key count passed as first argument
  lua: `
if ARGV[2] == '1' then
  local count = tonumber(redis.call('GET', KEYS[1]) or '0')
  if count > 0 then redis.call('DECR', KEYS[1]) end
end
redis.call('SET', KEYS[2], '1', 'PX', ARGV[1])
return 1`,
};

/** A source that authenticated a client stays exempt from its global cap for 7 days (D97.15). */
const TRUSTED_SOURCE_TTL_MS = 7 * 24 * 3600 * 1000;

/** The keys of one global client-auth reservation (caller owns the hash tag, see client-auth). */
export interface GlobalReserveKeys {
  gKey: string;
  okKey: string;
  logKey: string;
}

export interface GlobalReserveResult extends ReserveResult {
  /** First block of this window (log once). */
  first: boolean;
  /** This call incremented the bucket (not exempt, not blocked): only then may success refund it. */
  reserved: boolean;
}

type RateLimitRedis = {
  rateLimitHit(numKeys: number, ...keysAndArgs: (string | number)[]): Promise<number[]>;
  rateLimitReserve(numKeys: number, ...keysAndArgs: (string | number)[]): Promise<[number, number]>;
  rateLimitRefund(numKeys: number, ...keys: string[]): Promise<number>;
  rateLimitReserveGlobal(
    numKeys: number,
    ...keysAndArgs: (string | number)[]
  ): Promise<[number, number, number, number]>;
  rateLimitClientOk(numKeys: number, ...keysAndArgs: (string | number)[]): Promise<number>;
};

/** One bucket to charge in a {@link RateLimitService.reserve} call. */
export interface ReserveBucket {
  /** The full Redis key (caller owns hash-tag/slot placement, see client-auth). */
  key: string;
  limit: number;
}

export interface ReserveResult {
  blocked: boolean;
  /** Seconds until the exceeded window resets (0 when not blocked). */
  retryAfterSec: number;
}

/**
 * Multi-dimensional rate limiting on Redis (B1.8, spec §6.3): every present
 * dimension (IP, account, device) has its own counter; exceeding ANY of them
 * blocks the request, so rotating IPs does not bypass the per-account limit.
 * Identifiers are hashed so raw emails/IPs are not stored as Redis keys.
 */
@Injectable()
export class RateLimitService {
  private readonly defaults: { limit: number; windowSec: number };

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    const { rateLimitMax, rateLimitWindow } = config.getOrThrow<SecurityConfig>('security');
    this.defaults = { limit: rateLimitMax, windowSec: rateLimitWindow };
    loadLuaScripts(redis.client, [
      HIT_SCRIPT,
      RESERVE_SCRIPT,
      REFUND_SCRIPT,
      RESERVE_GLOBAL_SCRIPT,
      CLIENT_OK_SCRIPT,
    ]);
  }

  async hit(rule: RateLimitRule, subject: RateLimitSubject): Promise<RateLimitResult> {
    const limit = rule.limit ?? this.defaults.limit;
    const windowMs = (rule.windowSec ?? this.defaults.windowSec) * 1000;

    const dims = this.dimsFor(subject);
    if (dims.length === 0) {
      return { allowed: true, retryAfterSec: 0, exceeded: [] };
    }
    const keys = this.keysFor(rule, subject, dims);
    const client = this.redis.client as unknown as RateLimitRedis;
    const reply = await client.rateLimitHit(keys.length, ...keys, windowMs);

    const counts = dims.map((_, i) => ({ count: reply[i * 2], pttl: reply[i * 2 + 1] }));
    // `hit` counts THIS request: exceeded when the resulting count is strictly over the limit.
    return this.evaluate(dims, counts, (count) => count > limit);
  }

  /**
   * Atomically reserve one unit against EVERY bucket, used by the client-auth failure limiter
   * (DEBT-029/039). If any bucket is already at/over its limit the request is blocked WITHOUT
   * touching any counter — closing the peek→hit race the senior found, so Argon2 runs at most
   * `limit` times per window under unbounded concurrency. Callers own the Redis key (and its
   * hash-tag), so all buckets of one request can be forced onto the same cluster slot.
   */
  async reserve(buckets: ReserveBucket[], windowSec?: number): Promise<ReserveResult> {
    if (buckets.length === 0) {
      return { blocked: false, retryAfterSec: 0 };
    }
    const windowMs = (windowSec ?? this.defaults.windowSec) * 1000;
    const client = this.redis.client as unknown as RateLimitRedis;
    const keys = buckets.map((b) => b.key);
    const limits = buckets.map((b) => b.limit);
    const [blocked, retryAfterMs] = await client.rateLimitReserve(
      keys.length,
      ...keys,
      ...limits,
      windowMs,
    );
    return {
      blocked: blocked === 1,
      retryAfterSec: blocked === 1 ? Math.max(1, Math.ceil(retryAfterMs / 1000)) : 0,
    };
  }

  /**
   * Give back a reservation on a SUCCESSFUL authentication: each key is decremented only when it
   * exists and is `> 0` (never re-creates a key, never goes negative, keeps the existing TTL).
   * Best-effort: the caller treats a Redis error as a warning, not a failure (see client-auth).
   */
  async refund(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    const client = this.redis.client as unknown as RateLimitRedis;
    await client.rateLimitRefund(keys.length, ...keys);
  }

  /**
   * Reserve one unit against a client's global failure bucket (DEBT-072, D97.14 step 3), unless the
   * source is trusted. Blocked => nothing incremented. A Redis error propagates (fail-closed).
   */
  async reserveGlobal(keys: GlobalReserveKeys, limit: number): Promise<GlobalReserveResult> {
    const windowMs = this.defaults.windowSec * 1000;
    const client = this.redis.client as unknown as RateLimitRedis;
    const [blocked, retryAfterMs, first, reserved] = await client.rateLimitReserveGlobal(
      3,
      keys.gKey,
      keys.okKey,
      keys.logKey,
      limit,
      windowMs,
    );
    return {
      blocked: blocked === 1,
      retryAfterSec: blocked === 1 ? Math.max(1, Math.ceil(retryAfterMs / 1000)) : 0,
      first: first === 1,
      reserved: reserved === 1,
    };
  }

  /**
   * Successful client auth: trust this source for 7 days and refund the global bucket only when
   * `reserved` (see {@link GlobalReserveResult.reserved}, D97.14).
   */
  async clientOk(gKey: string, okKey: string, reserved: boolean): Promise<void> {
    const client = this.redis.client as unknown as RateLimitRedis;
    await client.rateLimitClientOk(2, gKey, okKey, TRUSTED_SOURCE_TTL_MS, reserved ? 1 : 0);
  }

  private dimsFor(subject: RateLimitSubject): (keyof RateLimitSubject)[] {
    return (Object.keys(subject) as (keyof RateLimitSubject)[]).filter((d) => subject[d]);
  }

  private keysFor(
    rule: RateLimitRule,
    subject: RateLimitSubject,
    dims: (keyof RateLimitSubject)[],
  ): string[] {
    return dims.map((d) => `rl:${rule.name}:${d}:${sha256(normalize(d, subject[d] as string))}`);
  }

  private evaluate(
    dims: (keyof RateLimitSubject)[],
    counts: { count: number; pttl: number }[],
    isExceeded: (count: number) => boolean,
  ): RateLimitResult {
    const exceeded: (keyof RateLimitSubject)[] = [];
    let retryAfterMs = 0;
    dims.forEach((dim, i) => {
      if (isExceeded(counts[i].count)) {
        exceeded.push(dim);
        retryAfterMs = Math.max(retryAfterMs, counts[i].pttl);
      }
    });
    return {
      allowed: exceeded.length === 0,
      retryAfterSec: exceeded.length ? Math.max(1, Math.ceil(retryAfterMs / 1000)) : 0,
      exceeded,
    };
  }
}

function normalize(dim: keyof RateLimitSubject, value: string): string {
  return dim === 'account' ? value.trim().toLowerCase() : value;
}
