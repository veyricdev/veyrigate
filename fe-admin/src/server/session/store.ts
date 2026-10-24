import "@tanstack/react-start/server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
import { z } from "@/lib/zod";
import { ServiceUnavailableError } from "../errors";

/**
 * Server-side session store (Q-42.1, closes DEBT-265). The browser only holds an opaque 256-bit id;
 * the Redis key is `fea:sess:` + HMAC-SHA256(id) so a Redis dump cannot be turned back into a
 * cookie, and the token blob {AT, RT, id_token} is AES-256-GCM encrypted (fresh IV per write, the
 * Redis key as AAD so a blob cannot be moved to another session).
 *
 * Lifetime: idle 30 min (sliding, `PEXPIRE` on read), absolute 8 h from `createdAt`.
 * Every Redis failure surfaces as {@link SessionUnavailableError} (callers answer 503 and keep the
 * cookie); a tampered/unknown record reads as `invalid` (caller drops the cookie).
 */

export const IDLE_MS = 30 * 60_000;
export const ABSOLUTE_MS = 8 * 60 * 60_000;
const PREFIX = "fea:sess:";
const TX_PREFIX = "fea:tx:";

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
}

export interface SessionData {
  sub: string;
  tenantId: string;
  roles: string[];
  email: string | null;
  /** ms epoch of the login that created this session (absolute timeout anchor). */
  createdAt: number;
  /** ms epoch at which the access token expires. */
  atExp: number;
  tokens: SessionTokens;
}

export type SessionLookup =
  | { status: "none" }
  | { status: "invalid" }
  | { status: "expired" }
  | { status: "ok"; data: SessionData };

export class SessionUnavailableError extends ServiceUnavailableError {
  constructor(cause: unknown) {
    super("Session store unavailable", { cause });
    this.name = "SessionUnavailableError";
  }
}

/** Login transaction (Task 2): server-side, single-use, 10 min. Never holds the state itself. */
export interface LoginTx {
  nonce: string;
  verifier: string;
  returnTo: string;
  stepUp: boolean;
  prevSub: string | null;
  prevTenantId: string | null;
  prevKey: string | null;
  /** ms epoch the login started (step-up: auth_time must not be older). */
  createdAt: number;
}

const LoginTxSchema = z.object({
  nonce: z.string(),
  verifier: z.string(),
  returnTo: z.string(),
  stepUp: z.boolean(),
  prevSub: z.string().nullable(),
  prevTenantId: z.string().nullable(),
  prevKey: z.string().nullable(),
  createdAt: z.number(),
});
export const TX_TTL_SEC = 600;

const StoredSchema = z.object({
  v: z.literal(1),
  sub: z.string().min(1),
  tenantId: z.string(),
  roles: z.array(z.string()),
  email: z.string().nullable(),
  createdAt: z.number(),
  atExp: z.number(),
  tokens: z.string(),
});
const TokensSchema = z.object({ accessToken: z.string(), refreshToken: z.string(), idToken: z.string() });

export interface SessionStoreOptions {
  redis: Redis;
  secret: string;
  now?: () => number;
}

export type SessionStore = ReturnType<typeof createSessionStore>;

const txKey = (state: string) => TX_PREFIX + createHash("sha256").update(state).digest("hex");

export function createSessionStore({ redis, secret, now = Date.now }: SessionStoreOptions) {
  const idKey = Buffer.from(hkdfSync("sha256", secret, "fea-session", "fea session id v1", 32));
  const encKey = Buffer.from(hkdfSync("sha256", secret, "fea-session", "fea session tokens v1", 32));

  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw new SessionUnavailableError(err);
    }
  };

  function encrypt(tokens: SessionTokens, key: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encKey, iv);
    cipher.setAAD(Buffer.from(key));
    const ct = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
    return [iv, ct, cipher.getAuthTag()].map((b) => b.toString("base64url")).join(".");
  }

  function decrypt(blob: string, key: string): SessionTokens | null {
    try {
      const [iv, ct, tag] = blob.split(".").map((p) => Buffer.from(p, "base64url"));
      if (!iv || !ct || !tag || iv.length !== 12 || tag.length !== 16) return null;
      const decipher = createDecipheriv("aes-256-gcm", encKey, iv);
      decipher.setAAD(Buffer.from(key));
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
      const parsed = TokensSchema.safeParse(JSON.parse(plain));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  const serialize = (data: SessionData, key: string) =>
    JSON.stringify({ ...data, v: 1, tokens: encrypt(data.tokens, key) });

  /** Remaining lifetime: idle window capped by the absolute deadline. */
  const ttl = (createdAt: number) => Math.min(IDLE_MS, createdAt + ABSOLUTE_MS - now());

  return {
    /** Redis key for a cookie value (HMAC: the key never contains the cookie value). */
    keyFor(cookieValue: string): string {
      return PREFIX + createHmac("sha256", idKey).update(cookieValue).digest("hex");
    },

    /** New session under a fresh random id; returns the cookie value and its key. */
    async create(data: SessionData): Promise<{ cookie: string; key: string }> {
      const cookie = randomBytes(32).toString("base64url");
      const key = this.keyFor(cookie);
      await call(() => redis.set(key, serialize(data, key), "PX", Math.max(1, ttl(data.createdAt)), "NX"));
      return { cookie, key };
    },

    /** Reads and slides the idle window (never past the absolute deadline). */
    async get(key: string): Promise<SessionLookup> {
      const raw = await call(() => redis.get(key));
      if (raw === null) return { status: "none" };
      let stored: z.infer<typeof StoredSchema> | null = null;
      try {
        const parsed = StoredSchema.safeParse(JSON.parse(raw));
        stored = parsed.success ? parsed.data : null;
      } catch {
        stored = null;
      }
      const tokens = stored && decrypt(stored.tokens, key);
      if (!stored || !tokens) {
        await call(() => redis.del(key));
        return { status: "invalid" };
      }
      const remaining = ttl(stored.createdAt);
      if (remaining <= 0) {
        await call(() => redis.del(key));
        return { status: "expired" };
      }
      await call(() => redis.pexpire(key, remaining));
      const { v: _v, ...rest } = stored;
      return { status: "ok", data: { ...rest, tokens } };
    },

    /** Overwrites an EXISTING session only (`SET XX KEEPTTL`): false when it was destroyed meanwhile. */
    async update(key: string, data: SessionData): Promise<boolean> {
      const res = await call(() => redis.set(key, serialize(data, key), "KEEPTTL", "XX"));
      return res === "OK";
    },

    async destroy(key: string): Promise<void> {
      await call(() => redis.del(key));
    },

    /** Stores a login transaction under sha256(state). */
    async putTx(state: string, tx: LoginTx): Promise<void> {
      await call(() => redis.set(txKey(state), JSON.stringify(tx), "EX", TX_TTL_SEC));
    },

    /** `GETDEL`: a transaction can be taken exactly once (callback replay => null). */
    async takeTx(state: string): Promise<LoginTx | null> {
      const raw = await call(() => redis.getdel(txKey(state)));
      if (raw === null) return null;
      try {
        const parsed = LoginTxSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
  };
}
