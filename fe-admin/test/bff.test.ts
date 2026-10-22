// @vitest-environment node
// BFF login / callback / refresh / step-up / logout against a fake IdP (injected fetch, real jose
// verification) and the real test Redis (vg-test-redis:6479; only our own keys are deleted).
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceUnavailableError } from "@/server/errors";
import { createSessionRedis } from "@/server/redis";
import { cookieNames } from "@/server/session/cookies";
import { connectTestRedis } from "./support/redis";
import {
  APP_URL,
  CLIENT_ID,
  ISSUER,
  callback,
  createFakeIdp,
  setCookies,
  signIn,
  startLogin,
  type FakeIdp,
} from "./support/fake-idp";

let redis: Redis;
let idp: FakeIdp;

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
  if (idp.sessionKeys.size) await redis.del(...idp.sessionKeys);
});
afterAll(() => redis.disconnect());

const req = (path: string, init: RequestInit & { cookie?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(`${APP_URL}${path}`, { ...init, headers });
};
const viewerOf = (sid: string) => idp.auth.viewer(req("/", { cookie: `fea_sid=${sid}` }));
const keyOf = (sid: string) => idp.store.keyFor(sid);
const rawSetCookie = (res: Response, name: string) =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));

/** A rejected callback: generic page, no session cookie, no detail or token in the body. */
async function expectRejected(res: Response, sessionsBefore = 0) {
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(rawSetCookie(res, "fea_sid")).toBeUndefined();
  expect(rawSetCookie(res, "fea_tx")).toMatch(/Max-Age=0/);
  const body = await res.text();
  expect(body).not.toMatch(/error_description|eyJ|rt-|at-/);
  expect(idp.sessionKeys.size).toBe(sessionsBefore);
}

describe("GET /auth/login", () => {
  it("redirects to /authorize with PKCE S256, fresh state/nonce, resource and the fixed scope", async () => {
    const s = await startLogin(idp, "?returnTo=%2Fclients");
    const p = s.authorize.searchParams;
    expect(`${s.authorize.origin}${s.authorize.pathname}`).toBe(`${ISSUER}/authorize`);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe(CLIENT_ID);
    expect(p.get("redirect_uri")).toBe(`${APP_URL}/auth/callback`);
    expect(p.get("scope")).toBe("openid email offline_access admin.read admin.write");
    expect(p.get("resource")).toBe(`${ISSUER}/admin/`);
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.has("prompt")).toBe(false);
    expect(s.authorize.toString()).not.toContain("clients"); // returnTo stays server-side
    const again = await startLogin(idp);
    expect(again.state).not.toBe(s.state);
    expect(again.nonce).not.toBe(s.nonce);
  });

  it("fea_tx = state, HttpOnly, SameSite=Lax, Path=/, 10 min, no Secure on http", async () => {
    const res = await idp.auth.login(req("/auth/login"));
    const c = rawSetCookie(res, "fea_tx")!;
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Lax/);
    expect(c).toMatch(/Path=\//);
    expect(c).toMatch(/Max-Age=600/);
    expect(c).not.toMatch(/Secure|Domain/);
    expect(c.split(";")[0]!.slice("fea_tx=".length)).toBe(
      new URL(res.headers.get("location")!).searchParams.get("state"),
    );
  });

  it("cookie names follow the APP_URL protocol: https => __Host- + Secure", () => {
    expect(cookieNames("https://admin.example.com")).toEqual({
      sid: "__Host-fea_sid",
      tx: "__Host-fea_tx",
      secure: true,
    });
    expect(cookieNames("http://localhost:3000")).toEqual({ sid: "fea_sid", tx: "fea_tx", secure: false });
  });

  it.each([
    ["//evil.com", "/"],
    ["/\\evil.com", "/"],
    ["https://evil.com", "/"],
    ["/auth/logout", "/"],
    ["/auth", "/"],
    ["/%2F%2Fevil.com", "/"],
    ["/a\nb", "/"],
    [`/${"a".repeat(512)}`, "/"],
    ["/clients?x=1#top", "/clients?x=1#top"],
  ])("returnTo %j => %j after the callback", async (returnTo, expected) => {
    const { res } = await signIn(idp, `?returnTo=${encodeURIComponent(returnTo)}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(expected);
  });
});

describe("GET /auth/callback", () => {
  it("happy path: new httpOnly session, tokens only in Redis, viewer is the allowlist", async () => {
    const { res, sid } = await signIn(idp, "?returnTo=%2Fclients");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/clients");
    const c = rawSetCookie(res, "fea_sid")!;
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Lax/);
    expect(c).not.toMatch(/Max-Age|Expires|Domain/);
    expect(sid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const code = idp.calls.token[0]!;
    expect(code.get("grant_type")).toBe("authorization_code");
    expect(code.get("redirect_uri")).toBe(`${APP_URL}/auth/callback`);
    expect(code.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const { viewer } = await viewerOf(sid);
    expect(viewer).toEqual({ sub: "user-1", email: "admin@example.com", roles: ["super_admin"], tenantId: "t1" });
    expect(JSON.stringify(viewer)).not.toMatch(/eyJ|at-|rt-/);
  });

  it("IdP error: generic page, error_description never echoed, transaction consumed", async () => {
    const s = await startLogin(idp);
    const res = await callback(
      idp,
      { error: "access_denied", error_description: "CANARY-desc", state: s.state, iss: ISSUER },
      { fea_tx: s.txCookie },
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toContain("CANARY-desc");
    expect(body).not.toContain("access_denied");
    await expectRejected(
      await callback(idp, { code: "c", state: s.state, iss: ISSUER }, { fea_tx: s.txCookie }),
    );
  });

  it("state not matching the fea_tx cookie => rejected", async () => {
    const s = await startLogin(idp);
    await expectRejected(await callback(idp, { code: "c", state: "x", iss: ISSUER }, { fea_tx: s.txCookie }));
    expect(idp.calls.token).toHaveLength(0);
  });

  it("missing fea_tx cookie => rejected", async () => {
    const s = await startLogin(idp);
    await expectRejected(await callback(idp, { code: "c", state: s.state, iss: ISSUER }, {}));
  });

  it("replayed callback (second use of the same state) => rejected, still one session", async () => {
    const s = await startLogin(idp);
    const first = await callback(idp, { code: "c", state: s.state, iss: ISSUER }, { fea_tx: s.txCookie });
    expect(first.status).toBe(302);
    await expectRejected(await callback(idp, { code: "c", state: s.state, iss: ISSUER }, { fea_tx: s.txCookie }), 1);
    expect(idp.calls.token).toHaveLength(1);
  });

  it.each([["missing", null], ["wrong", "http://evil.test"]])("iss %s => rejected before /token", async (_, iss) => {
    const s = await startLogin(idp);
    const params: Record<string, string> = { code: "c", state: s.state };
    if (iss) params.iss = iss;
    await expectRejected(await callback(idp, params, { fea_tx: s.txCookie }));
    expect(idp.calls.token).toHaveLength(0);
  });

  it.each<[string, (f: FakeIdp) => void]>([
    ["nonce mismatch", (f) => (f.idClaims = { nonce: "other" })],
    ["aud is another client", (f) => (f.idClaims = { aud: "someone-else" })],
    ["iss inside the token is wrong", (f) => (f.idClaims = { iss: "http://evil.test" })],
    ["signed with a foreign key", (f) => (f.signWith = "foreign")],
    ["alg none", (f) => (f.signWith = "none")],
    ["alg HS256", (f) => (f.signWith = "hs256")],
    ["expired", (f) => (f.idClaims = { exp: Math.floor(f.clock.now / 1000) - 3600, iat: Math.floor(f.clock.now / 1000) - 7200 })],
    ["sub not a string", (f) => (f.idClaims = { sub: 42 })],
    ["aud has several values and no azp", (f) => (f.idClaims = { aud: [CLIENT_ID, "other"] })],
    ["aud has several values and azp is another client", (f) => (f.idClaims = { aud: [CLIENT_ID, "other"], azp: "other" })],
  ])("ID token %s => rejected, refresh token revoked", async (_, tamper) => {
    tamper(idp);
    const s = await startLogin(idp);
    await expectRejected(await callback(idp, { code: "c", state: s.state, iss: ISSUER }, { fea_tx: s.txCookie }));
    expect(idp.calls.token).toHaveLength(1);
    expect(idp.calls.revoke).toHaveLength(1);
  });

  it("ID token with several aud values and azp = this client => accepted", async () => {
    idp.idClaims = { aud: [CLIENT_ID, "other"], azp: CLIENT_ID };
    const { res, sid } = await signIn(idp);
    expect(res.status).toBe(302);
    expect((await viewerOf(sid)).viewer?.sub).toBe("user-1");
    expect(idp.calls.revoke).toHaveLength(0);
  });

  it("/admin/me answering another sub => rejected", async () => {
    idp.me = () => ({ status: 200, body: { sub: "intruder", tenantId: "t1", roles: ["super_admin"] } });
    const s = await startLogin(idp);
    await expectRejected(await callback(idp, { code: "c", state: s.state, iss: ISSUER }, { fea_tx: s.txCookie }));
    expect(idp.calls.revoke).toHaveLength(1);
  });

  it("/admin/me failing (5xx) => rejected, no session", async () => {
    idp.me = () => ({ status: 500, body: {} });
    const s = await startLogin(idp);
    await expectRejected(await callback(idp, { code: "c", state: s.state, iss: ISSUER }, { fea_tx: s.txCookie }));
  });

  it("/userinfo answering another sub => rejected", async () => {
    idp.userinfo = () => ({ status: 200, body: { sub: "intruder", email: "x@example.com" } });
    const s = await startLogin(idp);
    await expectRejected(await callback(idp, { code: "c", state: s.state, iss: ISSUER }, { fea_tx: s.txCookie }));
  });

  it("/userinfo failing => session with email null (not blocking)", async () => {
    idp.userinfo = () => ({ status: 500, body: {} });
    const { sid } = await signIn(idp);
    expect((await viewerOf(sid)).viewer?.email).toBeNull();
  });

  it("token endpoint error => rejected, nothing echoed", async () => {
    idp.token = () => ({ status: 400, body: { error: "invalid_grant", error_description: "CANARY-token" } });
    const s = await startLogin(idp);
    const res = await callback(idp, { code: "c", state: s.state, iss: ISSUER }, { fea_tx: s.txCookie });
    expect(await res.clone().text()).not.toContain("CANARY-token");
    await expectRejected(res);
  });

  it("non-admin (admin/me 403 forbidden) => session without roles", async () => {
    idp.me = () => ({ status: 403, body: { error: "forbidden" } });
    const { sid } = await signIn(idp);
    expect((await viewerOf(sid)).viewer?.roles).toEqual([]);
  });

  it("Redis failing on the transaction read => 503 page, fea_tx still cleared (DEBT-286)", async () => {
    const s = await startLogin(idp);
    idp.store.takeTx = () => Promise.reject(new ServiceUnavailableError("redis down"));
    const res = await callback(idp, { code: "c", state: s.state, iss: ISSUER }, { fea_tx: s.txCookie });
    expect(res.status).toBe(503);
    await expectRejected(res);
    expect(idp.calls.token).toHaveLength(0);
  });

  it("session store failing after the code exchange => 503, fea_tx cleared, new RT revoked (DEBT-286)", async () => {
    const issued: string[] = [];
    const original = idp.token;
    idp.token = async (r) => {
      const reply = await original(r);
      issued.push(String(reply.body.refresh_token));
      return reply;
    };
    idp.store.create = () => Promise.reject(new ServiceUnavailableError("redis down"));
    const s = await startLogin(idp);
    const res = await callback(idp, { code: "c", state: s.state, iss: ISSUER }, { fea_tx: s.txCookie });
    expect(res.status).toBe(503);
    await expectRejected(res);
    expect(idp.calls.revoke).toEqual(issued);
  });

  it("unexpected throw after the code exchange => generic page, fea_tx cleared, new RT revoked (DEBT-286)", async () => {
    const first = await signIn(idp);
    const s = await startLogin(idp, "?stepup=1", `fea_sid=${first.sid}`);
    idp.sub = "user-2"; // step-up as another user => ends the previous session (store.get)...
    idp.store.get = () => Promise.reject(new ServiceUnavailableError("redis down")); // ...which throws
    const res = await callback(idp, { code: "c", state: s.state, iss: ISSUER }, { fea_tx: s.txCookie, fea_sid: first.sid });
    expect(res.status).toBe(503);
    await expectRejected(res, 1);
    expect(idp.calls.revoke).toHaveLength(1);
    expect(idp.calls.revoke[0]).toMatch(/^rt-/);
  });

  it("session fixation: the cookie after login differs from the one before, old session destroyed", async () => {
    const first = await signIn(idp);
    const second = await signIn(idp, "", `fea_sid=${first.sid}`);
    expect(second.sid).not.toBe(first.sid);
    expect(await redis.exists(keyOf(first.sid))).toBe(0);
    expect((await viewerOf(second.sid)).viewer?.sub).toBe("user-1");
  });
});

describe("viewer + refresh", () => {
  const nearExpiry = () => {
    idp.clock.now += 900_000 - 30_000; // 30 s left (< 60 s skew)
  };

  it("no cookie => null, cookie kept as is", async () => {
    expect(await idp.auth.viewer(req("/"))).toEqual({ viewer: null, setCookie: null });
  });

  it("forged cookie => null and the cookie is cleared", async () => {
    const r = await viewerOf("forged");
    expect(r.viewer).toBeNull();
    expect(r.setCookie).toMatch(/^fea_sid=; .*Max-Age=0/);
  });

  it("5 parallel requests near expiry => exactly one refresh_token call, all see the new AT", async () => {
    const { sid } = await signIn(idp);
    nearExpiry();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = idp.token;
    idp.token = async (r) => {
      await gate;
      return original(r);
    };
    const all = Promise.all(Array.from({ length: 5 }, () => viewerOf(sid)));
    await new Promise((r) => setTimeout(r, 50));
    release();
    const results = await all;
    expect(idp.calls.token.filter((f) => f.get("grant_type") === "refresh_token")).toHaveLength(1);
    for (const r of results) expect(r.viewer?.sub).toBe("user-1");
    const stored = await idp.store.get(keyOf(sid));
    expect(stored.status === "ok" && stored.data.atExp).toBe(idp.clock.now + 900_000);
    // AT is fresh now: no further refresh.
    await viewerOf(sid);
    expect(idp.calls.token.filter((f) => f.get("grant_type") === "refresh_token")).toHaveLength(1);
  });

  it("refresh rotates the RT and re-reads roles from /admin/me", async () => {
    const { sid } = await signIn(idp);
    const before = await idp.store.get(keyOf(sid));
    nearExpiry();
    idp.roles = ["tenant_admin"];
    expect((await viewerOf(sid)).viewer?.roles).toEqual(["tenant_admin"]);
    const after = await idp.store.get(keyOf(sid));
    expect(before.status === "ok" && after.status === "ok").toBe(true);
    if (before.status === "ok" && after.status === "ok") {
      expect(after.data.tokens.refreshToken).not.toBe(before.data.tokens.refreshToken);
      expect(idp.calls.token.at(-1)!.get("refresh_token")).toBe(before.data.tokens.refreshToken);
    }
  });

  it("refresh invalid_grant => session destroyed, viewer null (back to login)", async () => {
    const { sid } = await signIn(idp);
    nearExpiry();
    idp.token = () => ({ status: 400, body: { error: "invalid_grant" } });
    const r = await viewerOf(sid);
    expect(r.viewer).toBeNull();
    expect(r.setCookie).toMatch(/Max-Age=0/);
    expect(await redis.exists(keyOf(sid))).toBe(0);
  });

  it("refresh 5xx => 503 (ServiceUnavailableError), session kept, no retry", async () => {
    const { sid } = await signIn(idp);
    nearExpiry();
    idp.token = () => ({ status: 503, body: { error: "temporarily_unavailable" } });
    await expect(viewerOf(sid)).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(idp.calls.token.filter((f) => f.get("grant_type") === "refresh_token")).toHaveLength(1);
    expect(await redis.exists(keyOf(sid))).toBe(1);
  });

  it("refreshed ID token with another sub => session destroyed", async () => {
    const { sid } = await signIn(idp);
    nearExpiry();
    idp.idClaims = { sub: "someone-else" };
    expect((await viewerOf(sid)).viewer).toBeNull();
    expect(await redis.exists(keyOf(sid))).toBe(0);
  });

  it("logout while a refresh is in flight => key not resurrected, new RT revoked", async () => {
    const { sid } = await signIn(idp);
    nearExpiry();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = idp.token;
    idp.token = async (r) => {
      await gate;
      return original(r);
    };
    const pending = viewerOf(sid);
    await new Promise((r) => setTimeout(r, 50));
    await idp.store.destroy(keyOf(sid)); // logout in another tab
    release();
    expect((await pending).viewer).toBeNull();
    expect(await redis.exists(keyOf(sid))).toBe(0);
    expect(idp.calls.revoke).toHaveLength(1);
  });

  it("refresh: a session without a tenant picks up the tenant once granted admin (DEBT-287)", async () => {
    idp.me = () => ({ status: 403, body: { error: "forbidden" } });
    const { sid } = await signIn(idp);
    expect((await viewerOf(sid)).viewer).toMatchObject({ tenantId: "", roles: [] });
    nearExpiry();
    idp.me = () => ({ status: 200, body: { sub: idp.sub, tenantId: "t1", roles: ["tenant_admin"] } });
    expect((await viewerOf(sid)).viewer).toMatchObject({ sub: "user-1", tenantId: "t1", roles: ["tenant_admin"] });
    expect(idp.calls.revoke).toHaveLength(0);
  });

  it("refresh: /admin/me in another tenant => session destroyed, new RT revoked", async () => {
    const { sid } = await signIn(idp);
    nearExpiry();
    idp.tenantId = "t2";
    expect((await viewerOf(sid)).viewer).toBeNull();
    expect(await redis.exists(keyOf(sid))).toBe(0);
    expect(idp.calls.revoke).toHaveLength(1);
  });

  it("Redis down => ServiceUnavailableError (503, no redirect, cookie kept)", async () => {
    const down = createSessionRedis("redis://127.0.0.1:1/0");
    down.on("error", () => undefined);
    try {
      const broken = await createFakeIdp(down);
      await expect(broken.auth.viewer(req("/", { cookie: "fea_sid=abc" }))).rejects.toBeInstanceOf(
        ServiceUnavailableError,
      );
    } finally {
      down.disconnect();
    }
  });
});

describe("step-up (DEBT-117)", () => {
  it("stepup=1 with a session => prompt=login&max_age=0; same user => new session replaces the old", async () => {
    const first = await signIn(idp);
    const s = await startLogin(idp, "?stepup=1&returnTo=%2Fclients", `fea_sid=${first.sid}`);
    expect(s.authorize.searchParams.get("prompt")).toBe("login");
    expect(s.authorize.searchParams.get("max_age")).toBe("0");
    const res = await callback(
      idp,
      { code: "c", state: s.state, iss: ISSUER },
      { fea_tx: s.txCookie, fea_sid: first.sid },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/clients");
    const sid = setCookies(res).fea_sid!;
    expect(sid).not.toBe(first.sid);
    expect(await redis.exists(keyOf(first.sid))).toBe(0);
    expect((await viewerOf(sid)).viewer?.sub).toBe("user-1");
  });

  it("stepup=1 without a session => plain login (no prompt)", async () => {
    const s = await startLogin(idp, "?stepup=1");
    expect(s.authorize.searchParams.has("prompt")).toBe(false);
  });

  it("step-up signing in as ANOTHER user => both sessions gone, both RTs revoked", async () => {
    const first = await signIn(idp);
    const old = await idp.store.get(keyOf(first.sid));
    const s = await startLogin(idp, "?stepup=1", `fea_sid=${first.sid}`);
    idp.sub = "user-2";
    const res = await callback(
      idp,
      { code: "c", state: s.state, iss: ISSUER },
      { fea_tx: s.txCookie, fea_sid: first.sid },
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("session was ended");
    expect(rawSetCookie(res, "fea_sid")).toMatch(/Max-Age=0/);
    expect(await redis.exists(keyOf(first.sid))).toBe(0);
    expect(idp.sessionKeys.size).toBe(1); // only the first login ever created a session
    expect(idp.calls.revoke).toHaveLength(2);
    expect(old.status === "ok" && idp.calls.revoke).toContain(old.status === "ok" ? old.data.tokens.refreshToken : "");
  });

  it("step-up into another tenant => both sessions gone", async () => {
    const first = await signIn(idp);
    const s = await startLogin(idp, "?stepup=1", `fea_sid=${first.sid}`);
    idp.tenantId = "t2";
    const res = await callback(idp, { code: "c", state: s.state, iss: ISSUER }, { fea_tx: s.txCookie, fea_sid: first.sid });
    expect(res.status).toBe(403);
    expect(await redis.exists(keyOf(first.sid))).toBe(0);
  });

  it("step-up without a fresh auth_time => rejected", async () => {
    const first = await signIn(idp);
    const s = await startLogin(idp, "?stepup=1", `fea_sid=${first.sid}`);
    idp.idClaims = { auth_time: Math.floor(idp.clock.now / 1000) - 3600 };
    await expectRejected(
      await callback(idp, { code: "c", state: s.state, iss: ISSUER }, { fea_tx: s.txCookie, fea_sid: first.sid }),
      1,
    );
  });
});

describe("POST /auth/logout", () => {
  const post = (sid: string | null, headers: Record<string, string> = { "sec-fetch-site": "same-origin" }) =>
    idp.auth.logout(req("/auth/logout", { method: "POST", headers, cookie: sid ? `fea_sid=${sid}` : undefined }));

  it("GET => 405", async () => {
    const res = await idp.auth.logout(req("/auth/logout"));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it.each([
    ["Sec-Fetch-Site cross-site", { "sec-fetch-site": "cross-site" }],
    ["Sec-Fetch-Site same-site", { "sec-fetch-site": "same-site" }],
    ["no Sec-Fetch-Site, foreign Origin", { origin: "http://evil.test" }],
    ["no Sec-Fetch-Site, no Origin", {}],
  ])("%s => 403 and the session survives", async (_, headers) => {
    const { sid } = await signIn(idp);
    const res = await post(sid, headers as Record<string, string>);
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect((await viewerOf(sid)).viewer).not.toBeNull();
  });

  it("same-origin: session destroyed, cookie cleared, RT revoked, 303 to end_session with hint", async () => {
    const { sid } = await signIn(idp);
    const stored = await idp.store.get(keyOf(sid));
    const res = await post(sid);
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get("location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe(`${ISSUER}/logout`);
    expect(loc.searchParams.get("post_logout_redirect_uri")).toBe(`${APP_URL}/`);
    expect(loc.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(stored.status === "ok" && loc.searchParams.get("id_token_hint")).toBe(
      stored.status === "ok" ? stored.data.tokens.idToken : "",
    );
    expect(rawSetCookie(res, "fea_sid")).toMatch(/Max-Age=0/);
    expect(await redis.exists(keyOf(sid))).toBe(0);
    expect(idp.calls.revoke).toEqual([stored.status === "ok" ? stored.data.tokens.refreshToken : ""]);
  });

  it("Origin === APP_URL without Sec-Fetch-Site is accepted", async () => {
    const { sid } = await signIn(idp);
    expect((await post(sid, { origin: APP_URL })).status).toBe(303);
  });

  it("post_logout_redirect_uri never comes from the request", async () => {
    const { sid } = await signIn(idp);
    const res = await idp.auth.logout(
      req("/auth/logout?post_logout_redirect_uri=http%3A%2F%2Fevil.test", {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" },
        cookie: `fea_sid=${sid}`,
      }),
    );
    expect(new URL(res.headers.get("location")!).searchParams.get("post_logout_redirect_uri")).toBe(`${APP_URL}/`);
  });

  it("no session cookie => 303 /", async () => {
    const res = await post(null);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
  });

  it("discovery failing => generic page, session destroyed, cookie still cleared (DEBT-286)", async () => {
    const { sid } = await signIn(idp);
    idp.discovery = () => Promise.reject(new ServiceUnavailableError("idp down"));
    const res = await post(sid);
    expect(res.status).toBe(503);
    expect(rawSetCookie(res, "fea_sid")).toMatch(/Max-Age=0/);
    expect(await redis.exists(keyOf(sid))).toBe(0);
  });

  it("Redis down => cookie still cleared, 303 to end_session without hint", async () => {
    const down = createSessionRedis("redis://127.0.0.1:1/0");
    down.on("error", () => undefined);
    try {
      const broken = await createFakeIdp(down);
      const res = await broken.auth.logout(
        req("/auth/logout", { method: "POST", headers: { "sec-fetch-site": "same-origin" }, cookie: "fea_sid=abc" }),
      );
      expect(res.status).toBe(303);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.pathname).toBe("/logout");
      expect(loc.searchParams.has("id_token_hint")).toBe(false);
      expect(rawSetCookie(res, "fea_sid")).toMatch(/Max-Age=0/);
    } finally {
      down.disconnect();
    }
  });
});

describe("discovery trust (INV-6): client_secret only ever goes to the issuer origin", () => {
  const EVIL = "http://evil.test";
  it.each<[string, Record<string, string>]>([
    ["issuer is another IdP", { issuer: "http://other.test" }],
    ["issuer differs only by a trailing slash", { issuer: `${ISSUER}/` }],
    ["token_endpoint on another origin", { token_endpoint: `${EVIL}/token` }],
    ["token_endpoint on another port", { token_endpoint: "http://idp.test:8443/token" }],
    ["jwks_uri on another origin", { jwks_uri: `${EVIL}/jwks.json` }],
    ["revocation_endpoint on another origin", { revocation_endpoint: `${EVIL}/revoke` }],
    ["end_session_endpoint on another origin", { end_session_endpoint: `${EVIL}/logout` }],
    ["userinfo_endpoint on another origin", { userinfo_endpoint: `${EVIL}/userinfo` }],
    ["authorization_endpoint on another origin", { authorization_endpoint: `${EVIL}/authorize` }],
  ])("%s => discovery rejected, login and callback fail closed, /token never called", async (_, patch) => {
    Object.assign(idp.discoveryDoc, patch);
    await expect(idp.auth.login(req("/auth/login"))).rejects.toThrow(/^Discovery /);

    // A valid, browser-bound transaction still cannot reach the token endpoint.
    const state = "s".repeat(43);
    await idp.store.putTx(state, {
      nonce: "n",
      verifier: "v".repeat(43),
      returnTo: "/",
      stepUp: false,
      prevSub: null,
      prevTenantId: null,
      prevKey: null,
      createdAt: idp.clock.now,
    });
    const res = await callback(idp, { code: "c", state, iss: ISSUER }, { fea_tx: state });
    expect(res.status).toBe(500);
    await expectRejected(res);
    expect(idp.calls.token).toHaveLength(0);
    expect(idp.calls.revoke).toHaveLength(0);
    expect(idp.calls.urls.length).toBeGreaterThan(0);
    for (const u of idp.calls.urls) expect(u).toBe(`${ISSUER}/.well-known/openid-configuration`);
  });
});
