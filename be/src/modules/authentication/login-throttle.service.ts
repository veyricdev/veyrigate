import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieSerializeOptions } from '@fastify/cookie';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { generateToken, sha256 } from '../../common/crypto/crypto.util';
import type { SessionConfig } from '../../config/configuration';
import { RedisService } from '../../database/redis/redis.service';
import { RateLimitService } from '../security/rate-limit/rate-limit.service';
import { hostCookieName } from '../sessions/session.cookie';

/** Window of every login bucket (D85.2). */
export const LOGIN_THROTTLE_WINDOW_SEC = 900;
/** Attempts per (email, network) for an untrusted device. */
export const LOGIN_NETWORK_LIMIT = 5;
/** Attempts per email over every untrusted device. */
export const LOGIN_ACCOUNT_LIMIT = 20;
/** Attempts per (email, trusted device cookie); not charged to the network/account buckets. */
export const LOGIN_DEVICE_LIMIT = 10;
/** Current-password attempts per user at `/account/password` (DEBT-573, D85.6). */
export const PASSWORD_CHANGE_LIMIT = 5;
/** A device stays trusted this long after its last successful password login. */
const TRUST_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Trusted devices kept per user (oldest dropped). */
const TRUST_MAX_DEVICES = 20;

export const DEVICE_COOKIE = 'idp_dc';
/** `generateToken()` output: 32 bytes base64url. Anything else is ignored (never trusted). */
const DEVICE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export type ThrottleScope = 'network' | 'account' | 'device';

/** The buckets of one login attempt (all on the email's hash slot). */
export interface LoginBuckets {
  trusted: boolean;
  /** Keys reserved for this attempt, with the scope each one reports when it blocks. */
  keys: { key: string; limit: number; scope: ThrottleScope }[];
}

interface CookieRequest {
  cookies?: Record<string, string | undefined>;
}
interface CookieReply {
  setCookie(name: string, value: string, options: CookieSerializeOptions): unknown;
}

/**
 * The network of a client address (D85.2): IPv4 as is, IPv4-mapped IPv6 (any spelling) as its IPv4,
 * IPv6 as its /64 = first four zero-padded hextets (D86.14: that exact shape keeps the Redis bucket
 * keys byte-identical across the ipaddr.js switch, unlike `toNormalizedString()`). Node's `isIP` gates first because
 * `ipaddr.parse` also accepts `127.1`/hex/octal IPv4, which `req.ip` never carries. Empty or
 * unparsable => `unknown` (one shared bucket).
 */
export function networkOf(ip: string | undefined): string {
  const raw = (ip ?? '').trim();
  if (isIP(raw) === 0) return 'unknown';
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.process(raw.split('%')[0]);
  } catch {
    return 'unknown'; // Node accepted it, ipaddr.js did not: same bucket as any unparsable input
  }
  if (addr.kind() === 'ipv4') return addr.toString();
  // Same output as `toFixedLengthString()` cut to four hextets (that method is missing from the
  // package's typings).
  return (addr as ipaddr.IPv6).parts
    .slice(0, 4)
    .map((part) => part.toString(16).padStart(4, '0'))
    .join(':');
}

/**
 * Login throttle against brute force WITHOUT a lockout an attacker can trigger (DEBT-575, D85.2):
 * - an untrusted device is charged per (email, network) [N] and per email [A];
 * - a device that completed a password login for this user (device cookie, OWASP "device cookies")
 *   is charged only per (email, device) [D], so no request without the victim's cookie blocks the
 *   victim on a known device;
 * - nothing is written to the user (no hard lock).
 * Every key carries the email hash tag (same Redis Cluster slot). Reads that decide whether
 * Argon2 may run are fail-closed (a Redis error propagates); writing trust is fail-safe.
 */
@Injectable()
export class LoginThrottleService {
  private readonly logger = new Logger(LoginThrottleService.name);
  readonly cookieName: string;
  private readonly cookieOptions: CookieSerializeOptions;

  constructor(
    private readonly redis: RedisService,
    private readonly rateLimit: RateLimitService,
    config: ConfigService,
  ) {
    const secure = !!config.getOrThrow<SessionConfig>('session').cookieSecure;
    this.cookieName = hostCookieName(DEVICE_COOKIE, secure);
    this.cookieOptions = {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: TRUST_TTL_MS / 1000,
    };
  }

  /** The well-formed device token of the request, or undefined. */
  readDeviceToken(req: CookieRequest): string | undefined {
    const value = req.cookies?.[this.cookieName];
    return value && DEVICE_TOKEN_RE.test(value) ? value : undefined;
  }

  setDeviceCookie(reply: CookieReply, token: string): void {
    reply.setCookie(this.cookieName, token, this.cookieOptions);
  }

  /**
   * Buckets for this attempt. `userId` only when the account exists. Redis error => throws.
   * DEBT-597: a well-formed cookie is ALWAYS looked up (an unknown email uses a key that never
   * exists), so existing and unknown emails cost the same Redis round-trips.
   */
  async buckets(
    email: string,
    ip: string | undefined,
    userId: string | undefined,
    deviceToken: string | undefined,
  ): Promise<LoginBuckets> {
    const tag = emailTag(email);
    const owner = userId ?? `absent:${sha256(email)}`;
    const trusted = deviceToken !== undefined && (await this.isTrusted(owner, deviceToken));
    if (userId && deviceToken && trusted) {
      return {
        trusted: true,
        keys: [
          { key: `${tag}:d:${sha256(deviceToken)}`, limit: LOGIN_DEVICE_LIMIT, scope: 'device' },
        ],
      };
    }
    return {
      trusted: false,
      keys: [
        { key: `${tag}:n:${sha256(networkOf(ip))}`, limit: LOGIN_NETWORK_LIMIT, scope: 'network' },
        { key: `${tag}:a`, limit: LOGIN_ACCOUNT_LIMIT, scope: 'account' },
      ],
    };
  }

  /**
   * Atomically reserve one attempt on every bucket BEFORE Argon2. Blocked => the scope that blocked
   * and whether this is the first throttle report of that bucket in the window (audit once).
   */
  async reserve(
    b: LoginBuckets,
  ): Promise<
    | { blocked: false }
    | { blocked: true; retryAfterSec: number; scope: ThrottleScope; report: boolean }
  > {
    const result = await this.rateLimit.reserve(
      b.keys.map(({ key, limit }) => ({ key, limit })),
      LOGIN_THROTTLE_WINDOW_SEC,
    );
    if (!result.blocked) return { blocked: false };
    const counts = await this.redis.client.mget(...b.keys.map((k) => k.key));
    const hit = b.keys.find((k, i) => Number(counts[i] ?? 0) >= k.limit) ?? b.keys[0];
    const first = await this.redis.client.set(
      `${hit.key}:audited`,
      '1',
      'EX',
      LOGIN_THROTTLE_WINDOW_SEC,
      'NX',
    );
    return {
      blocked: true,
      retryAfterSec: result.retryAfterSec,
      scope: hit.scope,
      report: first === 'OK',
    };
  }

  /**
   * After a successful password login: clear this pair's attempts (N or D), give back the account
   * unit (untrusted only) and, with `trustDevice`, record a FRESH device token as trusted for the
   * user (DEBT-596, D85.11: never the presented value, which may be planted; the presented hash is
   * removed in the same MULTI). Best-effort: a failure only costs the throttle/trust state. Returns
   * the new token to set as the cookie, or undefined.
   */
  async onSuccess(
    b: LoginBuckets,
    userId: string,
    trustDevice: boolean,
    presented?: string,
  ): Promise<string | undefined> {
    try {
      await this.redis.client.del(b.keys[0].key);
      if (!b.trusted) await this.rateLimit.refund([b.keys[1].key]);
    } catch {
      this.logger.warn('login throttle: clearing attempts failed');
    }
    if (!trustDevice) return undefined;
    const deviceToken = generateToken();
    try {
      const now = Date.now();
      const key = trustKey(userId);
      const multi = this.redis.client.multi();
      if (presented) multi.zrem(key, sha256(presented));
      const replies = await multi
        .zadd(key, now, sha256(deviceToken))
        .zremrangebyscore(key, '-inf', `(${now - TRUST_TTL_MS}`)
        .zremrangebyrank(key, 0, -(TRUST_MAX_DEVICES + 1))
        .pexpire(key, TRUST_TTL_MS)
        .exec();
      if (!replies || replies.some(([err]) => err)) throw new Error('multi failed');
      return deviceToken;
    } catch {
      this.logger.warn('login throttle: recording the trusted device failed');
      return undefined;
    }
  }

  /**
   * Password change (DEBT-573, D85.6): reserve one current-password attempt for the user BEFORE
   * Argon2 (5 per 900 s). Blocked => whether this is the first report of the window (audit once).
   * Redis error => throws (fail-closed).
   */
  async reservePasswordChange(
    userId: string,
  ): Promise<{ blocked: false } | { blocked: true; retryAfterSec: number; report: boolean }> {
    const key = changeKey(userId);
    const result = await this.rateLimit.reserve(
      [{ key, limit: PASSWORD_CHANGE_LIMIT }],
      LOGIN_THROTTLE_WINDOW_SEC,
    );
    if (!result.blocked) return { blocked: false };
    const first = await this.redis.client.set(
      `${key}:audited`,
      '1',
      'EX',
      LOGIN_THROTTLE_WINDOW_SEC,
      'NX',
    );
    return { blocked: true, retryAfterSec: result.retryAfterSec, report: first === 'OK' };
  }

  /** Give the reservation back (policy refusal or success). Best-effort. */
  async refundPasswordChange(userId: string): Promise<void> {
    await this.rateLimit
      .refund([changeKey(userId)])
      .catch(() => this.logger.warn('password change: refund failed'));
  }

  /** Forget every trusted device of the user (credential revoke). Throws on Redis error. */
  async forgetDevices(userId: string): Promise<void> {
    await this.redis.client.del(trustKey(userId));
  }

  /** sha256 of the request's well-formed device cookie (the ZSET member), or undefined. */
  deviceHash(req: CookieRequest): string | undefined {
    const token = this.readDeviceToken(req);
    return token ? sha256(token) : undefined;
  }

  /**
   * Trusted devices of the user still inside the trust window (run 88, `/account/sessions`), newest
   * first: `device` = the ZSET member (sha256 of the cookie, one-way). Redis error => throws.
   */
  async listTrusted(userId: string): Promise<{ device: string; trustedAt: number }[]> {
    const flat = await this.redis.client.zrevrangebyscore(
      trustKey(userId),
      '+inf',
      String(Date.now() - TRUST_TTL_MS),
      'WITHSCORES',
    );
    const out: { device: string; trustedAt: number }[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      out.push({ device: flat[i], trustedAt: Number(flat[i + 1]) });
    }
    return out;
  }

  /**
   * Forget trusted devices of THIS user only (the key is derived from `userId`): one `device`, or
   * every device but `keep` (none kept when `keep` is undefined). Returns how many were removed.
   * Redis error => throws (fail-closed, D88.19). It never signs a session out.
   */
  async forgetTrusted(
    userId: string,
    which: { device: string } | { allBut?: string },
  ): Promise<number> {
    const key = trustKey(userId);
    if ('device' in which) return this.redis.client.zrem(key, which.device);
    const members = (await this.redis.client.zrange(key, '0', '-1')).filter(
      (m) => m !== which.allBut,
    );
    return members.length ? this.redis.client.zrem(key, ...members) : 0;
  }

  /** Drop the per-email account bucket (password reset: the owner proved control). */
  async clearAccount(email: string): Promise<void> {
    await this.redis.client.del(`${emailTag(email)}:a`);
  }

  private async isTrusted(userId: string, deviceToken: string): Promise<boolean> {
    const score = await this.redis.client.zscore(trustKey(userId), sha256(deviceToken));
    return score !== null && Number(score) >= Date.now() - TRUST_TTL_MS;
  }
}

const emailTag = (email: string): string => `lt:{e:${sha256(email)}}`;
const trustKey = (userId: string): string => `dc:{u:${sha256(userId)}}`;
const changeKey = (userId: string): string => `pwc:{u:${sha256(userId)}}`;
