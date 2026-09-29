import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChainableCommander } from 'ioredis';
import { generateToken, sha256 } from '../../common/crypto/crypto.util';
import type { TokenConfig } from '../../config/configuration';
import { loadLuaScripts } from '../../database/redis/lua-loader';
import { RedisService } from '../../database/redis/redis.service';

/** DI token for an injectable clock (ms epoch). Tests use it to jump past the absolute TTL. */
export const SESSION_CLOCK = 'SESSION_CLOCK';

export interface SessionData {
  userId: string;
  tenantId: string;
  /** ms epoch of the authentication that established the session. */
  authTime: number;
  createdAt: number;
  lastSeenAt: number;
  device: { label?: string };
}

/** A live session. `ref` = sha256(id): safe to show/pass around, cannot be turned back into the cookie. */
export interface Session extends SessionData {
  ref: string;
}

export interface CreateSessionOptions {
  deviceLabel?: string;
}

const sessKey = (ref: string): string => `sess:${ref}`;
const userKey = (userId: string): string => `user_sess:${userId}`;

/** Deletes every session in a user's index plus the index itself, atomically. */
const REVOKE_ALL_SCRIPT = {
  name: 'sessionRevokeAll',
  numberOfKeys: 1,
  lua: `
local refs = redis.call('SMEMBERS', KEYS[1])
for _, ref in ipairs(refs) do redis.call('DEL', 'sess:' .. ref) end
redis.call('DEL', KEYS[1])
return #refs`,
};

type SessionRedis = { sessionRevokeAll(key: string): Promise<number> };

async function execOrThrow(multi: ChainableCommander): Promise<unknown[]> {
  const results = await multi.exec();
  if (!results) {
    throw new Error('Redis transaction aborted');
  }
  return results.map(([err, value]) => {
    if (err) throw err;
    return value;
  });
}

/**
 * Server-side sessions on Redis (B2.3, spec §9.6, INV-16/17).
 *
 * - The raw session ID (CSPRNG, 256 bit) lives only in the cookie; Redis keys use sha256(id).
 * - Idle TTL slides on every `get`, never beyond `createdAt + absolute` (enforced by the key
 *   TTL *and* an explicit check).
 * - After `create`, writes use `SET ... XX` only, so a concurrent revoke is never undone.
 * - Redis errors propagate (→ 5xx); they are never reported as "no session".
 */
@Injectable()
export class SessionService {
  private readonly idleMs: number;
  private readonly absoluteMs: number;
  private readonly now: () => number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
    @Optional() @Inject(SESSION_CLOCK) now?: () => number,
  ) {
    const { sessionIdleTtl, sessionAbsoluteTtl } = config.getOrThrow<TokenConfig>('token');
    this.idleMs = sessionIdleTtl * 1000;
    this.absoluteMs = sessionAbsoluteTtl * 1000;
    this.now = now ?? Date.now;
    loadLuaScripts(redis.client, [REVOKE_ALL_SCRIPT]);
  }

  /** Create a new session. Returns the raw ID (for the cookie only) and the stored session. */
  async create(
    userId: string,
    tenantId: string,
    opts: CreateSessionOptions = {},
  ): Promise<{ id: string; session: Session }> {
    const id = generateToken();
    const ref = sha256(id);
    const now = this.now();
    const data: SessionData = {
      userId,
      tenantId,
      authTime: now,
      createdAt: now,
      lastSeenAt: now,
      device: opts.deviceLabel ? { label: opts.deviceLabel } : {},
    };
    const [set] = await execOrThrow(
      this.redis.client
        .multi()
        .set(sessKey(ref), JSON.stringify(data), 'PX', Math.min(this.idleMs, this.absoluteMs), 'NX')
        .sadd(userKey(userId), ref)
        .pexpire(userKey(userId), this.absoluteMs),
    );
    if (set !== 'OK') {
      throw new Error('Session ID collision');
    }
    return { id, session: { ref, ...data } };
  }

  /**
   * Establish an authenticated session (INV-17): always destroys `oldId` (anonymous or not,
   * valid or not) and issues a brand-new ID. The only way to go from "before login" to
   * "after login".
   */
  async establish(
    oldId: string | undefined,
    userId: string,
    tenantId: string,
    opts: CreateSessionOptions = {},
  ): Promise<{ id: string; session: Session }> {
    if (oldId) {
      await this.revoke(oldId);
    }
    return this.create(userId, tenantId, opts);
  }

  /** Look up a session by raw ID and slide its idle TTL. Returns null when missing/expired/revoked. */
  async get(id: string): Promise<Session | null> {
    if (!id) return null;
    const ref = sha256(id);
    const data = await this.read(ref);
    if (!data) return null;

    const now = this.now();
    const deadline = data.createdAt + this.absoluteMs;
    if (deadline <= now) {
      await this.revokeRef(ref, data.userId);
      return null;
    }
    const next: SessionData = { ...data, lastSeenAt: now };
    const ttlMs = Math.min(this.idleMs, deadline - now);
    // XX: only overwrite an existing key — never resurrect a session revoked in between.
    const ok = await this.redis.client.set(sessKey(ref), JSON.stringify(next), 'PX', ttlMs, 'XX');
    return ok === 'OK' ? { ref, ...next } : null;
  }

  /** Revoke by raw ID (logout / pre-login ID replacement). No-op if already gone. */
  async revoke(id: string): Promise<void> {
    const ref = sha256(id);
    const data = await this.read(ref);
    await this.revokeRef(ref, data?.userId);
  }

  /** Live sessions of a user (for "your devices"); prunes index entries whose session expired. */
  async listByUser(userId: string): Promise<Session[]> {
    const refs = await this.redis.client.smembers(userKey(userId));
    if (refs.length === 0) return [];
    const raws = await this.redis.client.mget(refs.map(sessKey));
    const now = this.now();
    const live: Session[] = [];
    const stale: string[] = [];
    refs.forEach((ref, i) => {
      const data = raws[i] ? (JSON.parse(raws[i]) as SessionData) : null;
      if (data && data.userId === userId && data.createdAt + this.absoluteMs > now) {
        live.push({ ref, ...data });
      } else {
        stale.push(ref);
      }
    });
    if (stale.length) {
      await this.redis.client.srem(userKey(userId), ...stale);
    }
    return live;
  }

  /**
   * Revoke one of the user's own sessions by `ref`. Checks ownership (index membership AND
   * stored userId) so a user cannot revoke someone else's session (IDOR). Returns true if revoked.
   */
  async revokeByDevice(userId: string, ref: string): Promise<boolean> {
    const isMember = await this.redis.client.sismember(userKey(userId), ref);
    if (!isMember) return false;
    const data = await this.read(ref);
    if (!data || data.userId !== userId) {
      if (!data) await this.redis.client.srem(userKey(userId), ref);
      return false;
    }
    await this.revokeRef(ref, userId);
    return true;
  }

  /** Revoke every session of a user (password change, account lock, "log out everywhere"). */
  async revokeAllForUser(userId: string): Promise<number> {
    return (this.redis.client as unknown as SessionRedis).sessionRevokeAll(userKey(userId));
  }

  private async read(ref: string): Promise<SessionData | null> {
    const raw = await this.redis.client.get(sessKey(ref));
    return raw ? (JSON.parse(raw) as SessionData) : null;
  }

  private async revokeRef(ref: string, userId: string | undefined): Promise<void> {
    const multi = this.redis.client.multi().del(sessKey(ref));
    if (userId) multi.srem(userKey(userId), ref);
    await execOrThrow(multi);
  }
}
