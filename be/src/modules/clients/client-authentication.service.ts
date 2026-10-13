import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sha256 } from '../../common/crypto/crypto.util';
import type { SecurityConfig } from '../../config/configuration';
import { RateLimitService } from '../security/rate-limit/rate-limit.service';
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
  constructor(readonly retryAfterSec: number) {
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

  constructor(
    private readonly clients: ClientService,
    private readonly credentials: ClientCredentialService,
    private readonly rateLimit: RateLimitService,
    config: ConfigService,
  ) {
    const security = config.getOrThrow<SecurityConfig>('security');
    this.failIpMax = security.clientAuthFailIpMax;
    this.failClientMax = security.clientAuthFailClientMax;
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
   *  3. On SUCCESS, `refund()` the reservation so a busy RP/RS is never throttled. On FAILURE the
   *     reservation stays, counting this failure. A 429 (step 1) increments nothing, so the window
   *     expires on its own and `Retry-After` stays exact.
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
      throw new ClientAuthRateLimitedError(reserved.retryAfterSec);
    }

    const client = await this.clients.findByClientId(input.clientId);
    // Always verify — even for an unknown client_id or a method mismatch — to equalise timing.
    const result = await this.credentials.verifySecret(input.clientId, input.secret ?? '');
    if (!client || client.tokenEndpointAuthMethod !== input.method || !result.valid) {
      // Failure: keep the reservation (it IS the failure count). Do NOT refund.
      throw new InvalidClientError();
    }

    // Success: give back the reservation (best-effort — a Redis error here only over-counts).
    await this.refund([ipKey, clientKey]);
    return client;
  }

  /** Best-effort refund of a successful auth: a Redis error warns but never fails the request. */
  private async refund(keys: string[]): Promise<void> {
    try {
      await this.rateLimit.refund(keys);
    } catch (err) {
      // Only the message — never the raw IP/client_id (they are hashed in the keys) or a secret.
      this.logger.warn(
        `client-auth rate-limit refund failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
