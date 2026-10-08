import { Injectable } from '@nestjs/common';
import { generateToken, sha256 } from '../../../common/crypto/crypto.util';
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
}

/** Redis key is sha256(code), never the raw code (tech-lead C1) — mirrors `sess:{sha256(id)}`. */
const codeKey = (code: string): string => `authz_code:${sha256(code)}`;

/**
 * Atomic consume-with-binding (spec §9.5): return the stored data and delete the key only when
 * both `clientId` and `redirectUri` match the caller's claim. A mismatch returns nil *without*
 * deleting — so a `/token` request carrying a wrong identifier can never pre-empt (DoS) the
 * legitimate holder of the code (INV-13). Single key (KEYS[1]) — Cluster-safe (no CROSSSLOT,
 * see DEBT-013 note in tasks.md).
 */
const CONSUME_SCRIPT = {
  name: 'consumeAuthCode',
  numberOfKeys: 1,
  lua: `
local value = redis.call('GET', KEYS[1])
if not value then return nil end
local data = cjson.decode(value)
if data.clientId ~= ARGV[1] or data.redirectUri ~= ARGV[2] then
  return nil
end
redis.call('DEL', KEYS[1])
return value`,
};

type AuthCodeRedis = {
  consumeAuthCode(key: string, clientId: string, redirectUri: string): Promise<string | null>;
};

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
  constructor(private readonly redis: RedisService) {
    loadLuaScripts(redis.client, [CONSUME_SCRIPT]);
  }

  /** Issue a new authorization code. Returns the raw code (for the redirect only) and its data. */
  async create(
    data: AuthorizationCodeData,
  ): Promise<{ code: string; data: AuthorizationCodeData }> {
    const code = generateToken();
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
   * Atomically consume a code bound to `clientId`/`redirectUri` (spec §9.5). Returns null when
   * missing, expired, already consumed, or when the identifiers do not match — in the mismatch
   * case the code is left intact so a subsequent legitimate consume can still succeed (INV-13).
   */
  async consume(
    code: string,
    clientId: string,
    redirectUri: string,
  ): Promise<AuthorizationCodeData | null> {
    if (!code) return null;
    const raw = await (this.redis.client as unknown as AuthCodeRedis).consumeAuthCode(
      codeKey(code),
      clientId,
      redirectUri,
    );
    return raw ? (JSON.parse(raw) as AuthorizationCodeData) : null;
  }
}
