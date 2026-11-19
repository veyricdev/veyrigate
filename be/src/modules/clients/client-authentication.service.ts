import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sha256 } from '../../common/crypto/crypto.util';
import {
  observeClientAuthRateLimited,
  type ClientAuthLimitScope,
} from '../../common/metrics/metrics';
import type { SecurityConfig } from '../../config/configuration';
import {
  RateLimitService,
  type GlobalReserveKeys,
} from '../security/rate-limit/rate-limit.service';
import { ClientCredentialService } from './client-credential.service';
import { ClientService, type Client, type TokenEndpointAuthMethod } from './client.service';

/**
 * Domain error for a failed `/token` client authentication (B3.3). Deliberately NOT an
 * HttpException: the OAuth error code/response shape is the caller's decision (future `/token`
 * controller, B4) — this file only decides *whether* authentication succeeded, never the HTTP
 * representation, and the message never includes the submitted secret.
 */
export class InvalidClientError extends Error {
  constructor(message = 'Client authentication failed') {
    super(message);
    this.name = 'InvalidClientError';
  }
}

/**
 * The client-auth failure rate limit (DEBT-029/039, spec §6.3) was exceeded: the caller sent too
 * many FAILED client authentications. Carries the `Retry-After` seconds; NOT an HttpException, the
 * controller maps it to 429 `temporarily_unavailable`. No secret/client_id in the message.
 */
export class ClientAuthRateLimitedError extends Error {
  /** `source` = per-IP buckets; `client` / `unknown_client` = global cap (DEBT-072, D97.14). */
  constructor(
    readonly retryAfterSec: number,
    readonly scope: ClientAuthLimitScope,
  ) {
    super('Client authentication temporarily rate limited');
    this.name = 'ClientAuthRateLimitedError';
  }
}

export interface ClientAuthenticationInput {
  clientId: string;
  method: TokenEndpointAuthMethod;
  /** Only present for `client_secret_basic`/`client_secret_post`. */
  secret?: string;
}

/** Request context for the failure rate limit. `ip` undefined => bucketed under `'unknown'`. */
export interface ClientAuthContext {
  ip: string | undefined;
}

/** Shared bucket for /token, /revoke, /introspect client auth (D6). */
const RATE_LIMIT_BUCKET = 'client-auth';

/**
 * Both failure buckets of one request share a hash tag on `sha256(ip)` so they land on the SAME
 * Redis Cluster slot (DEBT-013) — the atomic reserve/refund scripts touch multiple keys, which
 * requires a single slot. `account` keeps the `clientId|ip` scope (one client, one IP) but hashed,
 * so no raw client_id/IP is ever a Redis key.
 */
function failureKeys(ip: string, clientId: string): { ipKey: string; clientKey: string } {
  const tag = sha256(ip);
  return {
    ipKey: `rl:${RATE_LIMIT_BUCKET}:{${tag}}:ip`,
    clientKey: `rl:${RATE_LIMIT_BUCKET}:{${tag}}:client:${sha256(`${clientId}|${ip}`.toLowerCase())}`,
  };
}

/**
 * Global failure cap keys of one client (DEBT-072, D97.14), hash-tagged on `sha256(clientId)` of the
 * REGISTERED client. Every unknown client_id shares the `{unknown}` bucket (no key is ever derived
 * from an attacker-chosen id), and its `okKey` is never set, so no source is exempt there.
 */
function globalKeys(client: Client | null, ip: string): GlobalReserveKeys {
  const tag = client ? sha256(client.clientId) : 'unknown';
  const base = `rl:client-auth-g:{${tag}}`;
  return {
    gKey: base,
    okKey: client ? `${base}:ok:${sha256(ip)}` : `${base}:ok:never`,
    logKey: `${base}:logged`,
  };
}

/**
 * Client authentication for `/token` (B3.3, spec §9.3, INV-21; tech-lead C3/C4).
 *
 * - `none` (public client): no secret is compared. PKCE enforcement itself happens in the
 *   `/token` flow (B4) — out of scope here, this only checks the client is registered as
 *   `none` and does not accept a secret in its place.
 * - `client_secret_basic` / `client_secret_post`: delegates the secret check to
 *   `ClientCredentialService.verifySecret`, which accepts any still-valid version (rotation
 *   overlap, B3.1/C2) and never short-circuits across versions.
 *
 * Timing/enumeration (C4): for `basic`/`post`, `ClientCredentialService.verifySecret` always
 * runs an Argon2 verify — a dummy hash when the client has no valid credential (unknown
 * `client_id`, or fully expired/revoked) — so "client does not exist", "wrong method", and
 * "wrong secret" all take the same DB-lookup-plus-Argon2-verify shape and cannot be
 * distinguished by response timing alone.
 */
@Injectable()
export class ClientAuthenticationService {
  private readonly logger = new Logger(ClientAuthenticationService.name);
  private readonly failIpMax: number;
  private readonly failClientMax: number;
  private readonly failGlobalMax: number;
  private readonly failUnknownMax: number;

  constructor(
    private readonly clients: ClientService,
    private readonly credentials: ClientCredentialService,
    private readonly rateLimit: RateLimitService,
    config: ConfigService,
  ) {
    const security = config.getOrThrow<SecurityConfig>('security');
    this.failIpMax = security.clientAuthFailIpMax;
    this.failClientMax = security.clientAuthFailClientMax;
    this.failGlobalMax = security.clientAuthFailGlobalMax;
    this.failUnknownMax = security.clientAuthFailUnknownMax;
  }

  /**
   * Authenticate the client (B3.3), enforcing the failure rate limit (DEBT-029/039).
   *
   * Flow for a confidential client (`basic`/`post`) — reserve-then-refund (tech-lead retry-1 (a)):
   *  1. BEFORE any Argon2/DB work, atomically `reserve()` one unit against BOTH buckets (per-IP and
   *     per-`client_id|ip`). If either is already at/over its limit, nothing is incremented and we
   *     throw `ClientAuthRateLimitedError` — no Argon2, no DB lookup (closes the Mongo-query-on-a-
   *     blocked-request gap too). Because the check-and-increment is a single atomic script, Argon2
   *     runs at most `limit` times per window even under unbounded concurrency (no peek→hit race).
   *  2. `findByClientId` + verify the secret (dummy hash for unknown client_id, timing-equalised).
   *     Between the two (DEBT-072, D97.14), one unit is reserved against the client's GLOBAL failure
   *     bucket (all sources; unknown ids share one bucket) unless this source authenticated that
   *     client in the last 7 days. Blocked => the per-IP reservation is refunded (no Argon2 ran)
   *     and a 429 (`scope` client / unknown_client) is thrown.
   *  3. On SUCCESS, `refund()` the reservations so a busy RP/RS is never throttled, and trust the
   *     source for 7 days (best-effort). On FAILURE the reservations stay, counting this failure. A
   *     429 increments nothing, so the window expires on its own and `Retry-After` stays exact.
   *
   * `method === 'none'` (public client) never reserves/refunds: no secret to brute-force, no Argon2.
   */
  async authenticate(input: ClientAuthenticationInput, ctx: ClientAuthContext): Promise<Client> {
    if (input.method === 'none') {
      const client = await this.clients.findByClientId(input.clientId);
      if (!client || client.tokenEndpointAuthMethod !== 'none') {
        throw new InvalidClientError();
      }
      return client;
    }

    const ip = ctx.ip && ctx.ip.length > 0 ? ctx.ip : 'unknown';
    const { ipKey, clientKey } = failureKeys(ip, input.clientId);

    // Atomic reserve BEFORE findByClientId/Argon2 — a blocked request touches neither Mongo nor CPU.
    const reserved = await this.rateLimit.reserve([
      { key: ipKey, limit: this.failIpMax },
      { key: clientKey, limit: this.failClientMax },
    ]);
    if (reserved.blocked) {
      observeClientAuthRateLimited('source');
      throw new ClientAuthRateLimitedError(reserved.retryAfterSec, 'source');
    }

    const client = await this.clients.findByClientId(input.clientId);
    // DEBT-072: global cap per client_id (botnet rotating IPs). A Redis error propagates (fail-closed).
    const g = globalKeys(client, ip);
    const global = await this.rateLimit.reserveGlobal(
      g,
      client ? this.failGlobalMax : this.failUnknownMax,
    );
    if (global.blocked) {
      const scope = client ? 'client' : 'unknown_client';
      if (global.first) {
        // Once per client and window; the registered id only (never the IP or a secret).
        this.logger.warn(
          { clientId: client ? client.clientId : '(unknown)' },
          'client-auth global limit reached',
        );
      }
      await this.bestEffort('refund', this.rateLimit.refund([ipKey, clientKey])); // no Argon2 ran
      observeClientAuthRateLimited(scope);
      throw new ClientAuthRateLimitedError(global.retryAfterSec, scope);
    }
    // Always verify — even for an unknown client_id or a method mismatch — to equalise timing.
    const result = await this.credentials.verifySecret(input.clientId, input.secret ?? '');
    if (!client || client.tokenEndpointAuthMethod !== input.method || !result.valid) {
      // Failure: keep the reservation (it IS the failure count). Do NOT refund.
      throw new InvalidClientError();
    }

    // Success: give back the reservations (best-effort — a Redis error here only over-counts) and
    // trust the source; the global unit is refunded only if this request reserved it (exempt => no).
    await this.bestEffort('refund', this.rateLimit.refund([ipKey, clientKey]));
    await this.bestEffort(
      'trusted source update',
      this.rateLimit.clientOk(g.gKey, g.okKey, global.reserved),
    );
    return client;
  }

  /** Best-effort limiter bookkeeping: a Redis error warns but never fails the request. */
  private async bestEffort(what: string, op: Promise<void>): Promise<void> {
    try {
      await op;
    } catch (err) {
      // Only the message — never the raw IP/client_id (they are hashed in the keys) or a secret.
      this.logger.warn(
        `client-auth rate-limit ${what} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
