import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateToken, sha256 } from '../../../common/crypto/crypto.util';
import type { TokenConfig } from '../../../config/configuration';
import { loadLuaScripts } from '../../../database/redis/lua-loader';
import { RedisService } from '../../../database/redis/redis.service';

/** TTL of an AuthorizationCode (spec §9.1 step 3 / §9.5 / §10): fixed 60s, single-use. */
const CODE_TTL_MS = 60 * 1000;

/**
 * Persisted context of an issued authorization code (spec §9.1 step 3, §10).
 *
 * `authTime` is optional: carried through only when the caller already has it at hand
 * (e.g. from the session that produced this code) — B4.4 needs it for the access token's
 * `auth_time` claim, but this service never fabricates it.
 */
export interface AuthorizationCodeData {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource?: string;
  scope: string;
  nonce?: string;
  userId: string;
  authTime?: number;
  /** sha256 of the session cookie id that authorized this code; bound onto the RefreshToken so a
   * local logout can revoke only this browser session's refresh family (B4.7, OPEN-1). REQUIRED
   * (DEBT-043): every mint path sets it, and `/token` refuses a code whose session is no longer
   * live, so a logged-out session's code cannot still be exchanged. */
  sessionRef: string;
  /** Session authentication methods (DEBT-030). Absent on pre-run-32 codes => ID token `['pwd']`. */
  amr?: string[];
  /** Second-factor time of the session (run 89, D89.5); the `/token` admin gate reads it. */
  mfaAt?: number;
  /** Mint time, epoch ms (DEBT-209), set by `create` only. Absent on pre-run-56 codes => 0. */
  issuedAt?: number;
}

/** Redis key is sha256(code), never the raw code (tech-lead C1) — mirrors `sess:{sha256(id)}`. The
 * `{…}` hash tag (run 91, D91.6) puts the code and its used-mark in one Cluster slot. */
const codeKey = (code: string): string => `authz_code:{${sha256(code)}}`;
/** Used-mark of a consumed code (run 91, DEBT-651): which client redeemed it and what it issued. */
const usedKey = (code: string): string => `authz_code_used:{${sha256(code)}}`;
/** Minimum life of a used-mark; the real TTL is max(this, ACCESS_TOKEN_TTL) (D91.6). */
const MIN_USED_TTL_MS = 60 * 1000;

/**
 * Atomic consume-with-binding (spec §9.5 / §15 #13): return the stored data and delete the key
 * only when `clientId`, `redirectUri` *and* the PKCE `codeChallenge` all match the caller's claim.
 * A mismatch returns nil *without* deleting — so a `/token` request carrying a wrong identifier
 * or a wrong `code_verifier` can never pre-empt (DoS) the legitimate holder of the code (INV-13).
 * Run 91 (D91.6): the same script writes the used-mark (`clientId`, TTL ARGV[4] ms) in the step
 * that deletes the code, so a replay can never miss it. Both keys share one hash tag (Cluster-safe).
 */
const CONSUME_SCRIPT = {
  name: 'consumeAuthCode',
  numberOfKeys: 2,
  lua: `
local value = redis.call('GET', KEYS[1])
if not value then return nil end
local data = cjson.decode(value)
if data.clientId ~= ARGV[1] or data.redirectUri ~= ARGV[2] or data.codeChallenge ~= ARGV[3] then
  return nil
end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[2], 'clientId', ARGV[1])
redis.call('PEXPIRE', KEYS[2], ARGV[4])
return value`,
};

/**
 * After issuance (D91.6 step 2): record what the code issued on its used-mark, then report whether a
 * replay already flagged it. A mark that is gone (should not happen within its TTL) is recreated
 * with the TTL and reported not replayed.
 */
const MARK_ISSUED_SCRIPT = {
  name: 'markAuthCodeIssued',
  numberOfKeys: 1,
  lua: `
local existed = redis.call('EXISTS', KEYS[1])
redis.call('HSET', KEYS[1], 'jti', ARGV[1], 'atExp', ARGV[2])
if ARGV[3] ~= '' then redis.call('HSET', KEYS[1], 'familyId', ARGV[3]) end
if existed == 0 then redis.call('PEXPIRE', KEYS[1], ARGV[4]) end
return redis.call('HGET', KEYS[1], 'replayed')`,
};

/**
 * A redemption that found no code (D91.6 step 3 / D91.7): only when the used-mark exists AND was
 * written for the SAME client, flag it replayed and return what it issued; otherwise nothing.
 */
const MARK_REPLAYED_SCRIPT = {
  name: 'markAuthCodeReplayed',
  numberOfKeys: 1,
  lua: `
if redis.call('HGET', KEYS[1], 'clientId') ~= ARGV[1] then return nil end
redis.call('HSET', KEYS[1], 'replayed', '1')
return redis.call('HMGET', KEYS[1], 'familyId', 'jti', 'atExp')`,
};

type AuthCodeRedis = {
  consumeAuthCode(
    key: string,
    usedKey: string,
    clientId: string,
    redirectUri: string,
    codeChallenge: string,
    usedTtlMs: number,
  ): Promise<string | null>;
  markAuthCodeIssued(
    usedKey: string,
    jti: string,
    atExp: number,
    familyId: string,
    usedTtlMs: number,
  ): Promise<string | null>;
  markAuthCodeReplayed(
    usedKey: string,
    clientId: string,
  ): Promise<[string | null, string | null, string | null] | null>;
};

/** What a replayed code had issued (any part may be missing if issuance was still running). */
export interface ReplayedCodeIssue {
  familyId?: string;
  jti?: string;
  /** Access token `exp`, epoch seconds. */
  atExp?: number;
}

/**
 * AuthorizationCode store (B4.3, spec §9.1 step 3 / §9.5 / §10).
 *
 * - `create` mints an opaque code (CSPRNG) and stores its context under `sha256(code)`, TTL 60s,
 *   single-use (`SET ... PX NX`, same pattern as `AuthorizeRequestContextService.create`).
 * - `consume` is atomic consume-with-binding: mismatched `clientId`/`redirectUri` never deletes
 *   the code (INV-13); a correct consume is single-use (INV-1/2) and race-safe under concurrency.
 *
 * Never logs the plaintext `code` (INV-20) — only the opaque value is returned to the caller.
 */
@Injectable()
export class AuthorizationCodeService {
  /** Used-mark TTL: max(60 s, ACCESS_TOKEN_TTL) (D91.6) — a replay is caught while AT1 lives. */
  private readonly usedTtlMs: number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    loadLuaScripts(redis.client, [CONSUME_SCRIPT, MARK_ISSUED_SCRIPT, MARK_REPLAYED_SCRIPT]);
    const atTtlSec = config.getOrThrow<TokenConfig>('token').accessTokenTtl;
    this.usedTtlMs = Math.max(MIN_USED_TTL_MS, atTtlSec * 1000);
  }

  private get scripts(): AuthCodeRedis {
    return this.redis.client as unknown as AuthCodeRedis;
  }

  /** Issue a new authorization code. Returns the raw code (for the redirect only) and its data. */
  async create(
    input: Omit<AuthorizationCodeData, 'issuedAt'>,
  ): Promise<{ code: string; data: AuthorizationCodeData }> {
    const code = generateToken();
    const data: AuthorizationCodeData = { ...input, issuedAt: Date.now() };
    // PX + NX: set with TTL atomically; NX guards against the astronomically unlikely id reuse.
    const ok = await this.redis.client.set(
      codeKey(code),
      JSON.stringify(data),
      'PX',
      CODE_TTL_MS,
      'NX',
    );
    if (ok !== 'OK') {
      throw new Error('AuthorizationCode collision');
    }
    return { code, data };
  }

  /**
   * Read-only look at a code (DEBT-388): `GET` (no `DEL`, TTL untouched) + the SAME three-field
   * binding as the consume script, so `/token` can sign before consuming without a wrong verifier
   * or redirect_uri ever reaching the signer (INV-13). `raw` is passed back to `consume` as
   * `expectedRaw`. Never logs.
   */
  async peek(
    code: string,
    clientId: string,
    redirectUri: string,
    codeChallenge: string,
  ): Promise<{ raw: string; data: AuthorizationCodeData } | null> {
    if (!code) return null;
    const raw = await this.redis.client.get(codeKey(code));
    if (!raw) return null;
    const data = JSON.parse(raw) as AuthorizationCodeData;
    if (
      data.clientId !== clientId ||
      data.redirectUri !== redirectUri ||
      data.codeChallenge !== codeChallenge
    ) {
      return null;
    }
    return { raw, data };
  }

  /**
   * Atomically consume a code bound to `clientId`/`redirectUri`/`codeChallenge` (spec §9.5 /
   * §15 #13). Returns null when missing, expired, already consumed, or when any of the three
   * identifiers do not match — in the mismatch case the code is left intact so a subsequent
   * legitimate consume can still succeed (INV-13). `codeChallenge` is `S256(code_verifier)`, so
   * a wrong `code_verifier` cannot delete another holder's code (PKCE bound *before* DEL).
   * `expectedRaw` (DEBT-388): the value `peek` saw; a consumed value that differs is refused (null)
   * — a code is immutable after `SET NX`, so a difference means the signed tokens are not for it.
   */
  async consume(
    code: string,
    clientId: string,
    redirectUri: string,
    codeChallenge: string,
    expectedRaw?: string,
  ): Promise<AuthorizationCodeData | null> {
    if (!code) return null;
    const raw = await this.scripts.consumeAuthCode(
      codeKey(code),
      usedKey(code),
      clientId,
      redirectUri,
      codeChallenge,
      this.usedTtlMs,
    );
    if (!raw || (expectedRaw !== undefined && raw !== expectedRaw)) return null;
    return JSON.parse(raw) as AuthorizationCodeData;
  }

  /**
   * D91.6 step 2: record the issued `jti`/`atExp` (+ `familyId`) on the code's used-mark and return
   * whether a same-client replay already flagged it (then the caller must not return the tokens).
   * Redis errors propagate (the caller fails closed).
   */
  async markIssued(
    code: string,
    issued: { jti: string; atExp: number; familyId?: string },
  ): Promise<boolean> {
    const replayed = await this.scripts.markAuthCodeIssued(
      usedKey(code),
      issued.jti,
      issued.atExp,
      issued.familyId ?? '',
      this.usedTtlMs,
    );
    return replayed === '1';
  }

  /**
   * D91.6 step 3 / D91.7: a code that could not be redeemed. When its used-mark exists and belongs
   * to `clientId` (the AUTHENTICATED client of this request), flag it replayed and return what it
   * issued; null when there is no mark or it belongs to another client (nothing is touched then).
   * Redis errors propagate.
   */
  async markReplayed(code: string, clientId: string): Promise<ReplayedCodeIssue | null> {
    if (!code) return null;
    const hit = await this.scripts.markAuthCodeReplayed(usedKey(code), clientId);
    if (!hit) return null;
    const [familyId, jti, atExp] = hit;
    return {
      ...(familyId ? { familyId } : {}),
      ...(jti ? { jti } : {}),
      ...(atExp ? { atExp: Number(atExp) } : {}),
    };
  }
}
