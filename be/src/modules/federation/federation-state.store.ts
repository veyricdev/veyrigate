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
  /** The context's `reauthAfter` (ms epoch, `prompt=login`/`max_age`, DEBT-189 F2). */
  reauthAfter?: number;
}

/** Keyed by sha256(state): the raw state only travels through the browser/provider. */
const stateKey = (state: string): string => `fed_state:${sha256(state)}`;

/** TTL of a pending account link (B5.3, F6): 10 min, single-use. */
export const FED_LINK_TTL_MS = 10 * 60 * 1000;

/**
 * A verified provider identity whose email matches an existing local account (B5.3, INV-22): it is
 * linked only after the browser that ran this leg signs in to THAT account with its password.
 * Never logged; the raw token lives only in the `idp_link` cookie.
 */
export interface FederationLinkRecord {
  provider: ProviderName;
  providerId: string;
  /** Normalized provider-verified email: the login identifier at `POST /auth/link` (never a form field). */
  email: string;
  /** The local account the email belonged to at callback time. */
  userId: string;
  requestId: string;
  /** = the leg's `bindingHash` (sha256 of `idp_fed`). */
  bindingHash: string;
  createdAt: number;
}

const linkKey = (token: string): string => `fed_link:${sha256(token)}`;

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
  async create(record: FederationStateRecord): Promise<string> {
    const state = generateToken();
    const ok = await this.redis.client.set(
      stateKey(state),
      JSON.stringify(record),
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

  /** Store a pending link (`SET NX PX`); returns the raw CSPRNG token for the `idp_link` cookie. */
  async createLink(record: Omit<FederationLinkRecord, 'createdAt'>): Promise<string> {
    const token = generateToken();
    const value: FederationLinkRecord = { ...record, createdAt: Date.now() };
    const ok = await this.redis.client.set(
      linkKey(token),
      JSON.stringify(value),
      'PX',
      FED_LINK_TTL_MS,
      'NX',
    );
    if (ok !== 'OK') throw new Error('federation link collision');
    return token;
  }

  /** Read without consuming (link page render / rate-limit key). null when missing/expired. */
  async peekLink(token: string | undefined): Promise<FederationLinkRecord | null> {
    if (!token) return null;
    const raw = await this.redis.client.get(linkKey(token));
    return raw ? (JSON.parse(raw) as FederationLinkRecord) : null;
  }

  /** Atomic read-and-delete (single-use, F8). null when missing/expired/already consumed. */
  async consumeLink(token: string | undefined): Promise<FederationLinkRecord | null> {
    if (!token) return null;
    const raw = await (this.redis.client as unknown as FedRedis).fedStateConsume(linkKey(token));
    return raw ? (JSON.parse(raw) as FederationLinkRecord) : null;
  }
}
