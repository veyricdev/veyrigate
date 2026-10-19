import { Injectable } from '@nestjs/common';
import { generateToken, sha256 } from '../../common/crypto/crypto.util';
import { loadLuaScripts } from '../../database/redis/lua-loader';
import { RedisService } from '../../database/redis/redis.service';
import type { ProviderName } from './providers';

/** TTL of the IdP's own provider-leg `state` (F5): 10 min, fixed, single-use. */
export const FED_STATE_TTL_MS = 10 * 60 * 1000;

/** What the IdP remembers about one provider leg (spec §9.9 step 2). Never logged. */
export interface FederationStateRecord {
  provider: ProviderName;
  /** The resumable `/authorize` context this leg belongs to (only peeked, never consumed here). */
  requestId: string;
  codeVerifier: string;
  nonce: string;
  /** sha256 of the `idp_fed` browser-binding cookie (anti login-CSRF). */
  bindingHash: string;
  /** Re-authentication demanded by the context (F8). */
  reauth: boolean;
  createdAt: number;
}

/** Keyed by sha256(state): the raw state only travels through the browser/provider. */
const stateKey = (state: string): string => `fed_state:${sha256(state)}`;

/** Atomic single-use read (same pattern as `authzCtxConsume`): GET + DEL in one script. */
const CONSUME_SCRIPT = {
  name: 'fedStateConsume',
  numberOfKeys: 1,
  lua: `
local v = redis.call('GET', KEYS[1])
if v then redis.call('DEL', KEYS[1]) end
return v`,
};

type FedRedis = { fedStateConsume(key: string): Promise<string | null> };

@Injectable()
export class FederationStateStore {
  constructor(private readonly redis: RedisService) {
    loadLuaScripts(redis.client, [CONSUME_SCRIPT]);
  }

  /** Mint a CSPRNG `state` and store its record (`SET NX PX`). Returns the raw state. */
  async create(record: Omit<FederationStateRecord, 'createdAt'>): Promise<string> {
    const state = generateToken();
    const value: FederationStateRecord = { ...record, createdAt: Date.now() };
    const ok = await this.redis.client.set(
      stateKey(state),
      JSON.stringify(value),
      'PX',
      FED_STATE_TTL_MS,
      'NX',
    );
    if (ok !== 'OK') throw new Error('federation state collision');
    return state;
  }

  /** Read-and-delete. null when missing/expired/already consumed. */
  async consume(state: string): Promise<FederationStateRecord | null> {
    if (!state) return null;
    const raw = await (this.redis.client as unknown as FedRedis).fedStateConsume(stateKey(state));
    return raw ? (JSON.parse(raw) as FederationStateRecord) : null;
  }
}
