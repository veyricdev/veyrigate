// @vitest-environment node
// Tester risk matrix (run 42 A4): combinations not covered by bff.test.ts — concurrent callback
// replay, cookie tampering / foreign HMAC secret, idle + absolute expiry seen through the BFF,
// real logout racing a refresh, two-tab login, tampered tx in Redis, extra returnTo variants.
// Fake IdP (injected fetch, real jose) + real test Redis (vg-test-redis:6479; only own keys DEL'd).
import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ABSOLUTE_MS } from "@/server/session/store";
import { connectTestRedis } from "./support/redis";
import { APP_URL, ISSUER, callback, createFakeIdp, setCookies, signIn, startLogin, type FakeIdp } from "./support/fake-idp";

let redis: Redis;
let idp: FakeIdp;
const extraKeys = new Set<string>();

beforeAll(async () => {
  redis = await connectTestRedis();
});
beforeEach(async () => {
  idp = await createFakeIdp(redis);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  const keys = [...idp.sessionKeys, ...extraKeys];
  extraKeys.clear();
  if (keys.length) await redis.del(...keys);
});
afterAll(() => redis.disconnect());

const req = (path: string, init: RequestInit & { cookie?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(`${APP_URL}${path}`, { ...init, headers });
};
const viewerOf = (f: FakeIdp, sid: string) => f.auth.viewer(req("/", { cookie: `fea_sid=${sid}` }));
const codeGrants = (f: FakeIdp) => f.calls.token.filter((t) => t.get("grant_type") === "authorization_code");
const refreshGrants = (f: FakeIdp) => f.calls.token.filter((t) => t.get("grant_type") === "refresh_token");
const sidCookie = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith("fea_sid="));
const txKey = (state: string) => `fea:tx:${createHash("sha256").update(state).digest("hex")}`;

describe("callback: concurrency / replay / browser binding", () => {
  it("5 concurrent callbacks with the same state + cookie => exactly one session, one code exchange", async () => {
    const s = await startLogin(idp);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => callback(idp, { code: "c1", state: s.state, iss: ISSUER }, { fea_tx: s.txCookie })),
    );
    const ok = results.filter((r) => r.status === 302);
    expect(ok).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(4);
    for (const r of results.filter((x) => x.status === 400)) expect(sidCookie(r)).toBeUndefined();
    expect(codeGrants(idp)).toHaveLength(1);
    expect(idp.sessionKeys.size).toBe(1);
  });

  it("two tabs: the first tab's callback after the second login overwrote fea_tx => rejected; second works", async () => {
    const first = await startLogin(idp);
    const second = await startLogin(idp);
    // The browser only keeps the latest fea_tx (same name / path).
    const stale = await callback(idp, { code: "c1", state: first.state, iss: ISSUER }, { fea_tx: second.txCookie });
    expect(stale.status).toBe(400);
    expect(sidCookie(stale)).toBeUndefined();
    expect(codeGrants(idp)).toHaveLength(0);
    const fresh = await callback(idp, { code: "c2", state: second.state, iss: ISSUER }, { fea_tx: second.txCookie });
    expect(fresh.status).toBe(302);
    expect(setCookies(fresh).fea_sid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    extraKeys.add(txKey(first.state)); // never consumed: clean it up ourselves
  });

  it("empty state with an empty fea_tx cookie => rejected (empty is not a match)", async () => {
    const res = await callback(idp, { code: "c1", state: "", iss: ISSUER }, { fea_tx: "" });
    expect(res.status).toBe(400);
    expect(codeGrants(idp)).toHaveLength(0);
  });

  it("missing code with a valid state => rejected, transaction consumed (no second try)", async () => {
    const s = await startLogin(idp);
    const res = await callback(idp, { state: s.state, iss: ISSUER }, { fea_tx: s.txCookie });
    expect(res.status).toBe(400);
    expect(await redis.exists(txKey(s.state))).toBe(0);
    const again = await callback(idp, { code: "c1", state: s.state, iss: ISSUER }, { fea_tx: s.txCookie });
    expect(again.status).toBe(400);
    expect(codeGrants(idp)).toHaveLength(0);
  });

  it("returnTo tampered inside the Redis transaction is re-validated at the callback", async () => {
    const s = await startLogin(idp, "?returnTo=%2Fclients");
    const key = txKey(s.state);
    const tx = JSON.parse((await redis.get(key))!);
    await redis.set(key, JSON.stringify({ ...tx, returnTo: "//evil.com" }), "KEEPTTL");
    const res = await callback(idp, { code: "c1", state: s.state, iss: ISSUER }, { fea_tx: s.txCookie });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });
});

describe("returnTo variants (open redirect)", () => {
  it.each([
    ["/%5Cevil.com", "/"],
    ["/%5cevil.com", "/"],
    ["/\tevil.com", "/"],
    ["/\u0000x", "/"],
    ["/\u0085x", "/"],
    ["\\\\evil.com", "/"],
    ["http:/evil.com", "/"],
    ["javascript:alert(1)", "/"],
    ["", "/"],
    ["/%2e%2e/auth/logout", "/"],
    ["/./auth/login", "/"],
    ["/auth%2Flogout", "/"],
    ["/auth?x=1", "/"],
    [`/${"a".repeat(511)}`, `/${"a".repeat(511)}`],
    ["/users?next=//evil.com", "/users?next=//evil.com"],
  ])("returnTo %j => %j", async (returnTo, expected) => {
    const { res } = await signIn(idp, `?returnTo=${encodeURIComponent(returnTo)}`);
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(location).toBe(expected);
    // Whatever was kept resolves on fe-admin's own origin.
    expect(new URL(location, APP_URL).origin).toBe(APP_URL);
  });

  it("repeated returnTo params: only the first is used and still validated", async () => {
    const { res } = await signIn(idp, "?returnTo=%2F%2Fevil.com&returnTo=%2Fclients");
    expect(res.headers.get("location")).toBe("/");
  });
});

describe("session cookie tampering / guessing", () => {
  it("a valid cookie with one character changed => null + clear cookie; the real session is untouched", async () => {
    const { sid } = await signIn(idp);
    const flipped = (sid[0] === "A" ? "B" : "A") + sid.slice(1);
    const r = await viewerOf(idp, flipped);
    expect(r.viewer).toBeNull();
    expect(r.setCookie).toMatch(/^fea_sid=; .*Max-Age=0/);
    expect(await redis.exists(idp.store.keyFor(sid))).toBe(1);
    expect((await viewerOf(idp, sid)).viewer?.sub).toBe("user-1");
  });

  it("guessed / malformed cookies (empty-ish, huge, injection) => null, no throw, no Redis write", async () => {
    for (const guess of ["0", "a".repeat(43), "x".repeat(4096), "%00", "' OR 1=1 --", "fea:sess:*"]) {
      const r = await viewerOf(idp, encodeURIComponent(guess));
      expect(r.viewer).toBeNull();
    }
    expect(idp.sessionKeys.size).toBe(0);
  });

  it("a cookie from a deployment with another SESSION_SECRET (wrong HMAC) cannot address the session", async () => {
    const { sid } = await signIn(idp);
    const other = await createFakeIdp(redis); // same Redis, different secret
    const r = await viewerOf(other, sid);
    expect(r.viewer).toBeNull();
    expect(await redis.exists(idp.store.keyFor(sid))).toBe(1);
  });

  it("a ciphertext copied from another session into this key does not decrypt (AAD binds the key)", async () => {
    const a = await signIn(idp);
    const b = await signIn(idp);
    const keyA = idp.store.keyFor(a.sid);
    const keyB = idp.store.keyFor(b.sid);
    await redis.set(keyA, (await redis.get(keyB))!, "KEEPTTL");
    const r = await viewerOf(idp, a.sid);
    expect(r.viewer).toBeNull();
    expect(r.setCookie).toMatch(/Max-Age=0/);
    expect(await redis.exists(keyA)).toBe(0);
  });
});

describe("expiry seen through the BFF", () => {
  it("idle: once Redis expires the key, the viewer is null and the cookie is cleared", async () => {
    const { sid } = await signIn(idp);
    const key = idp.store.keyFor(sid);
    await redis.pexpire(key, 1);
    await expect.poll(() => redis.exists(key), { interval: 5, timeout: 2000 }).toBe(0);
    const r = await viewerOf(idp, sid);
    expect(r.viewer).toBeNull();
    expect(r.setCookie).toMatch(/Max-Age=0/);
    expect(refreshGrants(idp)).toHaveLength(0);
  });

  it("absolute: past 8 h the session is gone even if it was used a second ago (no refresh attempted)", async () => {
    const { sid } = await signIn(idp);
    idp.clock.now += ABSOLUTE_MS - 60_000;
    // Still alive one minute before the deadline (AT expired => one refresh).
    expect((await viewerOf(idp, sid)).viewer?.sub).toBe("user-1");
    const ttl = await redis.pttl(idp.store.keyFor(sid));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
    const refreshesBefore = refreshGrants(idp).length;
    idp.clock.now += 61_000;
    const r = await viewerOf(idp, sid);
    expect(r.viewer).toBeNull();
    expect(r.setCookie).toMatch(/Max-Age=0/);
    expect(await redis.exists(idp.store.keyFor(sid))).toBe(0);
    expect(refreshGrants(idp)).toHaveLength(refreshesBefore);
  });
});

describe("logout racing a refresh (real POST /auth/logout)", () => {
  it("logout while the refresh is in flight => session not resurrected, old + new RT revoked", async () => {
    const { sid } = await signIn(idp);
    const before = await idp.store.get(idp.store.keyFor(sid));
    const oldRt = before.status === "ok" ? before.data.tokens.refreshToken : "";
    idp.clock.now += 900_000 - 30_000;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inFlight = new Promise<void>((r) => (entered = r));
    const original = idp.token;
    idp.token = async (r) => {
      entered();
      await gate;
      return original(r);
    };
    const pending = viewerOf(idp, sid);
    await inFlight; // the refresh grant is on the wire
    const out = await idp.auth.logout(
      req("/auth/logout", { method: "POST", headers: { "sec-fetch-site": "same-origin" }, cookie: `fea_sid=${sid}` }),
    );
    expect(out.status).toBe(303);
    expect(new URL(out.headers.get("location")!).searchParams.get("id_token_hint")).toBeTruthy();
    release();
    expect((await pending).viewer).toBeNull();
    expect(await redis.exists(idp.store.keyFor(sid))).toBe(0);
    expect(idp.calls.revoke).toHaveLength(2);
    expect(idp.calls.revoke[0]).toBe(oldRt);
    expect(idp.calls.revoke[1]).not.toBe(oldRt);
    // The browser comes back with the stale cookie: still nothing.
    expect((await viewerOf(idp, sid)).viewer).toBeNull();
  });

  it("logout replayed with the same cookie => 303 end_session without hint, nothing revoked again", async () => {
    const { sid } = await signIn(idp);
    const post = () =>
      idp.auth.logout(
        req("/auth/logout", { method: "POST", headers: { "sec-fetch-site": "same-origin" }, cookie: `fea_sid=${sid}` }),
      );
    expect((await post()).status).toBe(303);
    const again = await post();
    expect(again.status).toBe(303);
    expect(new URL(again.headers.get("location")!).searchParams.has("id_token_hint")).toBe(false);
    expect(idp.calls.revoke).toHaveLength(1);
  });
});

describe("step-up edge cases", () => {
  it("step-up whose previous session was logged out meanwhile => plain new session for the same user", async () => {
    const { sid } = await signIn(idp);
    const s = await startLogin(idp, "?stepup=1&returnTo=%2Fkeys", `fea_sid=${sid}`);
    expect(s.authorize.searchParams.get("prompt")).toBe("login");
    await idp.store.destroy(idp.store.keyFor(sid)); // other tab logged out
    const res = await callback(idp, { code: "c1", state: s.state, iss: ISSUER }, { fea_tx: s.txCookie, fea_sid: sid });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/keys");
    const fresh = setCookies(res).fea_sid!;
    expect(fresh).not.toBe(sid);
    expect((await viewerOf(idp, fresh)).viewer?.sub).toBe("user-1");
  });

  it("step-up transaction used with a different (attacker) session cookie still compares against prevSub", async () => {
    const victim = await signIn(idp);
    const s = await startLogin(idp, "?stepup=1", `fea_sid=${victim.sid}`);
    idp.sub = "attacker";
    idp.nonce = s.nonce;
    const res = await callback(idp, { code: "c1", state: s.state, iss: ISSUER }, { fea_tx: s.txCookie });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("ended for security reasons");
    expect(await redis.exists(idp.store.keyFor(victim.sid))).toBe(0);
    expect(idp.sessionKeys.size).toBe(1); // only the victim's original session was ever created
  });
});
