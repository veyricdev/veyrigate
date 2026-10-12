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
// Tombstone written by every active session-termination path (logout, device revoke, password
// reset, absolute-lifetime expiry via `get`). While it lives, an access token carrying `sid=ref`
// is inactive at `/introspect` + `/userinfo` (DEBT-037). TTL = access TTL + 60s so it outlives
// every access token that could still carry that `sid`, with a small race/skew margin. Same ref →
// same Cluster slot as `sess:{ref}` (DEBT-013, no worse than today).
const sessEndKey = (ref: string): string => `sess_end:${ref}`;
// Set of client ids that received an authorization code during this session (B4.7 front-channel):
// used to pick which RPs to notify on logout. Lives on the same node as `sess:{ref}` (same ref →
// same Cluster slot) so DEL in the revoke paths is Cluster-safe (DEBT-013, no worse than today).
const sessRpKey = (ref: string): string => `sess_rp:${ref}`;

/**
 * Deletes every session in a user's index (plus its `sess_rp` set) and the index itself,
 * atomically. Clearing `sess_rp:{ref}` here keeps the front-channel RP set from outliving the
 * sessions it belongs to (B4.7). For each revoked session it also writes the `sess_end:{ref}`
 * tombstone (TTL = ARGV[1] ms) so access tokens carrying that `sid` go inactive immediately
 * (DEBT-037). `sess_end`/`sess_rp` keys are not declared in KEYS (same slot as `sess:{ref}`,
 * DEBT-013) — no worse than the existing DELs.
 */
const REVOKE_ALL_SCRIPT = {
  name: 'sessionRevokeAll',
  numberOfKeys: 1,
  lua: `
local refs = redis.call('SMEMBERS', KEYS[1])
for _, ref in ipairs(refs) do
  redis.call('DEL', 'sess:' .. ref)
  redis.call('DEL', 'sess_rp:' .. ref)
  redis.call('SET', 'sess_end:' .. ref, '1', 'PX', ARGV[1])
end
redis.call('DEL', KEYS[1])
return #refs`,
};

type SessionRedis = { sessionRevokeAll(key: string, endTtlMs: number): Promise<number> };

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
  /** TTL (ms) of a `sess_end` tombstone: access TTL + 60s so it outlives every `sid`-bearing AT. */
  private readonly endTtlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
    @Optional() @Inject(SESSION_CLOCK) now?: () => number,
  ) {
    const { sessionIdleTtl, sessionAbsoluteTtl, accessTokenTtl } =
      config.getOrThrow<TokenConfig>('token');
    this.idleMs = sessionIdleTtl * 1000;
    this.absoluteMs = sessionAbsoluteTtl * 1000;
    this.endTtlMs = accessTokenTtl * 1000 + 60_000;
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
    return (this.redis.client as unknown as SessionRedis).sessionRevokeAll(
      userKey(userId),
      this.endTtlMs,
    );
  }

  /**
   * Whether the session `ref` is still live, i.e. `sess:{ref}` exists (DEBT-043). Unlike `get`
   * this neither slides the idle TTL nor needs the raw cookie id — it is a pure read used by
   * `/token` (authorization_code) to refuse minting a refresh family for a session that has been
   * logged out (or idle-expired) within the code's ≤60s window. Redis errors propagate so the
   * caller fails closed (never silently "alive"). `ref` must already be a session ref.
   */
  async exists(ref: string): Promise<boolean> {
    return (await this.redis.client.exists(sessKey(ref))) === 1;
  }

  /**
   * Whether the session `ref` was actively ended (logout / device revoke / password reset /
   * absolute-lifetime expiry), i.e. a `sess_end:{ref}` tombstone exists (DEBT-037). A session that
   * merely expired naturally has NO tombstone, so this returns `false`. Redis errors propagate so a
   * caller fails closed (never silently "not ended"). `ref` is not validated here — the caller
   * (`isAccessTokenLive`) already rejects a malformed `sid` before calling.
   */
  async isEnded(ref: string): Promise<boolean> {
    return (await this.redis.client.exists(sessEndKey(ref))) === 1;
  }

  private async read(ref: string): Promise<SessionData | null> {
    const raw = await this.redis.client.get(sessKey(ref));
    return raw ? (JSON.parse(raw) as SessionData) : null;
  }

  private async revokeRef(ref: string, userId: string | undefined): Promise<void> {
    // Write the `sess_end:{ref}` tombstone (DEBT-037) in the same atomic MULTI as the deletes so
    // every active-termination path (logout, device revoke, password reset, absolute expiry via
    // `get`) makes a `sid=ref` access token inactive immediately. A natural TTL expiry (idle) never
    // comes through here, so `offline_access` tokens survive it.
    const multi = this.redis.client
      .multi()
      .del(sessKey(ref))
      .del(sessRpKey(ref))
      .set(sessEndKey(ref), '1', 'PX', this.endTtlMs);
    if (userId) multi.srem(userKey(userId), ref);
    await execOrThrow(multi);
  }

  /**
   * Record that a client received an authorization code in this session (B4.7 front-channel).
   * Idempotent `SADD`; the set expires with the session's absolute lifetime so it never outlives
   * the sessions it tracks. Best-effort: used only to pick front-channel RPs, never for auth.
   */
  async recordClientForSession(ref: string, clientId: string): Promise<void> {
    await this.redis.client
      .multi()
      .sadd(sessRpKey(ref), clientId)
      .pexpire(sessRpKey(ref), this.absoluteMs)
      .exec();
  }

  /** Client ids that received a code in this session (front-channel RP candidates). */
  async clientsForSession(ref: string): Promise<string[]> {
    return this.redis.client.smembers(sessRpKey(ref));
  }

  /** Union of front-channel RP candidates across every live session of a user (global logout). */
  async clientsForUser(userId: string): Promise<string[]> {
    const sessions = await this.listByUser(userId);
    const sets = await Promise.all(sessions.map((s) => this.clientsForSession(s.ref)));
    return [...new Set(sets.flat())];
  }
}
