// @vitest-environment node
// Session store against the real test Redis (vg-test-redis:6479). Only keys created here are touched.
import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ABSOLUTE_MS,
  IDLE_MS,
  SessionUnavailableError,
  createSessionStore,
  type SessionData,
} from "@/server/session/store";
import { createSessionRedis } from "@/server/redis";
import { connectTestRedis } from "./support/redis";

let redis: Redis;
const created: string[] = [];
const T0 = 1_800_000_000_000;
let clock = T0;
const secret = () => randomBytes(32).toString("base64url");
const store = (s = secret()) => createSessionStore({ redis, secret: s, now: () => clock });

const RT = "rt-plain-0123456789";
const data = (over: Partial<SessionData> = {}): SessionData => ({
  sub: "user-1",
  tenantId: "t1",
  roles: ["super_admin"],
  email: "admin@example.com",
  createdAt: clock,
  atExp: clock + 900_000,
  tokens: { accessToken: "eyJhbGciOi.access.sig", refreshToken: RT, idToken: "eyJhbGciOi.id.sig" },
  ...over,
});
async function make(s = store(), d = data()) {
  const r = await s.create(d);
  created.push(r.key);
  return r;
}

beforeAll(async () => {
  redis = await connectTestRedis();
});
afterEach(async () => {
  clock = T0;
  if (created.length) await redis.del(...created.splice(0));
});
afterAll(() => redis.disconnect());

describe("session store (Redis)", () => {
  it("create -> get round-trips the record; cookie is 256-bit base64url", async () => {
    const s = store();
    const { cookie, key } = await make(s);
    expect(cookie).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(key).toBe(s.keyFor(cookie));
    const got = await s.get(key);
    expect(got).toEqual({ status: "ok", data: data() });
  });

  it("the Redis key never contains the cookie value; the value holds no token in clear", async () => {
    const s = store();
    const { cookie, key } = await make(s);
    expect(key.startsWith("fea:sess:")).toBe(true);
    expect(key).not.toContain(cookie);
    const raw = (await redis.get(key))!;
    expect(raw).not.toContain("eyJ");
    expect(raw).not.toContain(RT);
    expect(raw).not.toContain(cookie);
    expect(JSON.parse(raw).v).toBe(1);
  });

  it("an unknown / forged cookie => none", async () => {
    const s = store();
    await make(s);
    expect(await s.get(s.keyFor(randomBytes(32).toString("base64url")))).toEqual({ status: "none" });
  });

  it("another SESSION_SECRET cannot address the session", async () => {
    const { cookie } = await make(store());
    const other = store();
    expect(await other.get(other.keyFor(cookie))).toEqual({ status: "none" });
  });

  it("one byte of ciphertext changed (GCM tag) => invalid and the key is removed", async () => {
    const s = store();
    const { key } = await make(s);
    const stored = JSON.parse((await redis.get(key))!);
    const [iv, ct, tag] = stored.tokens.split(".");
    const bytes = Buffer.from(ct, "base64url");
    bytes[0] ^= 0x01;
    stored.tokens = [iv, bytes.toString("base64url"), tag].join(".");
    await redis.set(key, JSON.stringify(stored), "KEEPTTL");
    expect(await s.get(key)).toEqual({ status: "invalid" });
    expect(await redis.exists(key)).toBe(0);
  });

  it("a blob moved to another session key does not decrypt (key is the AAD)", async () => {
    const s = store();
    const a = await make(s);
    const b = await make(s);
    await redis.set(b.key, (await redis.get(a.key))!, "KEEPTTL");
    expect(await s.get(b.key)).toEqual({ status: "invalid" });
  });

  it("unknown record version / garbage => invalid", async () => {
    const s = store();
    const { key } = await make(s);
    const stored = JSON.parse((await redis.get(key))!);
    await redis.set(key, JSON.stringify({ ...stored, v: 2 }), "KEEPTTL");
    expect(await s.get(key)).toEqual({ status: "invalid" });
    const second = await make(s);
    await redis.set(second.key, "not json", "KEEPTTL");
    expect(await s.get(second.key)).toEqual({ status: "invalid" });
  });

  it("idle: TTL is 30 min and every read slides it back", async () => {
    const s = store();
    const { key } = await make(s);
    expect(await redis.pttl(key)).toBeGreaterThan(IDLE_MS - 5_000);
    await redis.pexpire(key, 10_000);
    await s.get(key);
    expect(await redis.pttl(key)).toBeGreaterThan(IDLE_MS - 5_000);
  });

  it("idle expiry: once the TTL runs out the session is gone", async () => {
    const s = store();
    const { key } = await make(s);
    await redis.pexpire(key, 30);
    await new Promise((r) => setTimeout(r, 80));
    expect(await s.get(key)).toEqual({ status: "none" });
  });

  it("the sliding TTL never passes the absolute 8 h deadline", async () => {
    const s = store();
    const { key } = await make(s);
    clock = T0 + ABSOLUTE_MS - 60_000;
    expect((await s.get(key)).status).toBe("ok");
    const pttl = await redis.pttl(key);
    expect(pttl).toBeLessThanOrEqual(60_000);
    expect(pttl).toBeGreaterThan(55_000);
  });

  it("absolute expiry => expired and the key is deleted", async () => {
    const s = store();
    const { key } = await make(s);
    clock = T0 + ABSOLUTE_MS;
    expect(await s.get(key)).toEqual({ status: "expired" });
    expect(await redis.exists(key)).toBe(0);
  });

  it("update rewrites an existing session and keeps its TTL", async () => {
    const s = store();
    const { key } = await make(s);
    await redis.pexpire(key, 100_000);
    expect(await s.update(key, data({ roles: [] }))).toBe(true);
    expect(await redis.pttl(key)).toBeLessThanOrEqual(100_000);
    const got = await s.get(key);
    expect(got.status === "ok" && got.data.roles).toEqual([]);
  });

  it("update after destroy => false and the key is NOT recreated (SET XX)", async () => {
    const s = store();
    const { key } = await make(s);
    await s.destroy(key);
    expect(await s.update(key, data())).toBe(false);
    expect(await redis.exists(key)).toBe(0);
  });

  it("login transaction is single-use (GETDEL) and keyed by a hash of state", async () => {
    const s = store();
    const state = randomBytes(32).toString("base64url");
    const tx = {
      nonce: "n",
      verifier: "v",
      returnTo: "/x",
      stepUp: false,
      prevSub: null,
      prevTenantId: null,
      prevKey: null,
      createdAt: clock,
    };
    await s.putTx(state, tx);
    expect(await s.takeTx(state)).toEqual(tx);
    expect(await s.takeTx(state)).toBeNull();
  });

  it("Redis unreachable => SessionUnavailableError (fail fast, no queue)", async () => {
    const down = createSessionRedis("redis://127.0.0.1:1/0");
    down.on("error", () => undefined);
    try {
      const s = createSessionStore({ redis: down, secret: secret() });
      await expect(s.get(s.keyFor("x"))).rejects.toBeInstanceOf(SessionUnavailableError);
    } finally {
      down.disconnect();
    }
  });
});
