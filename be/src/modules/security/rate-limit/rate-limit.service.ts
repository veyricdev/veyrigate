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

type RateLimitRedis = {
  rateLimitHit(numKeys: number, ...keysAndArgs: (string | number)[]): Promise<number[]>;
};

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
    loadLuaScripts(redis.client, [HIT_SCRIPT]);
  }

  async hit(rule: RateLimitRule, subject: RateLimitSubject): Promise<RateLimitResult> {
    const limit = rule.limit ?? this.defaults.limit;
    const windowMs = (rule.windowSec ?? this.defaults.windowSec) * 1000;

    const dims = (Object.keys(subject) as (keyof RateLimitSubject)[]).filter((d) => subject[d]);
    if (dims.length === 0) {
      return { allowed: true, retryAfterSec: 0, exceeded: [] };
    }
    const keys = dims.map(
      (d) => `rl:${rule.name}:${d}:${sha256(normalize(d, subject[d] as string))}`,
    );
    const client = this.redis.client as unknown as RateLimitRedis;
    const reply = await client.rateLimitHit(keys.length, ...keys, windowMs);

    const exceeded: (keyof RateLimitSubject)[] = [];
    let retryAfterMs = 0;
    dims.forEach((dim, i) => {
      const count = reply[i * 2];
      const pttl = reply[i * 2 + 1];
      if (count > limit) {
        exceeded.push(dim);
        retryAfterMs = Math.max(retryAfterMs, pttl);
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
