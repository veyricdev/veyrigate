// @vitest-environment node
// Run 43: an unreachable IdP is a dead dependency (503, DEBT-289) while a wrong discovery document
// stays a 500 (configuration, fail-closed); `azp` with a single `aud` (OIDC Core §3.1.3.7).
// Run 44: forced refresh racing ordinary refreshes (DEBT-296).
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceUnavailableError, withErrorPage } from "@/server/errors";
import { createDiscovery } from "@/server/oidc/discovery";
import { connectTestRedis } from "./support/redis";
import { APP_URL, ISSUER, callback, createFakeIdp, setCookies, signIn, startLogin, type FakeIdp } from "./support/fake-idp";
import type { SessionLookup } from "@/server/session/store";

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

const login = (cookie = "") =>
  withErrorPage("login", (r: Request) => idp.auth.login(r))(
    new Request(`${APP_URL}/auth/login`, { headers: cookie ? { cookie } : {} }),
  );
const logout = (sid: string) =>
  withErrorPage("logout", (r: Request) => idp.auth.logout(r))(
    new Request(`${APP_URL}/auth/logout`, {
      method: "POST",
      headers: { cookie: `fea_sid=${sid}`, "sec-fetch-site": "same-origin" },
    }),
  );
const clearsSid = (res: Response) => res.headers.getSetCookie().some((c) => /^fea_sid=; .*Max-Age=0/.test(c));

describe("DEBT-289: discovery unreachable => 503", () => {
  const unreachable = () => {
    idp.discovery = createDiscovery(ISSUER, (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);
  };

  it("discovery fetch rejects => ServiceUnavailableError", async () => {
    unreachable();
    await expect(idp.discovery()).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it("login => 503 page", async () => {
    unreachable();
    const res = await login();
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("fetch failed");
  });

  it("logout => 503 page that still clears fea_sid", async () => {
    const { sid } = await signIn(idp);
    unreachable();
    const res = await logout(sid);
    expect(res.status).toBe(503);
    expect(clearsSid(res)).toBe(true);
    expect(await redis.exists(idp.store.keyFor(sid))).toBe(0);
  });

  it("discovery answers 500 => 503", async () => {
    idp.discovery = createDiscovery(ISSUER, (async () => new Response("down", { status: 500 })) as typeof fetch);
    await expect(idp.discovery()).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect((await login()).status).toBe(503);
  });

  it("discovery timeout (AbortSignal) => 503", async () => {
    idp.discovery = createDiscovery(ISSUER, (async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as typeof fetch);
    expect((await login()).status).toBe(503);
  });

  it("issuer mismatch stays a 500 (configuration error, fail-closed)", async () => {
    idp.discoveryDoc.issuer = "http://evil.test";
    await expect(idp.discovery()).rejects.not.toBeInstanceOf(ServiceUnavailableError);
    expect((await login()).status).toBe(500);
  });

  it("discovery 404 stays a 500", async () => {
    idp.discovery = createDiscovery(ISSUER, (async () => new Response("", { status: 404 })) as typeof fetch);
    expect((await login()).status).toBe(500);
  });
});

describe("azp (DEBT-288 part)", () => {
  it("single aud with azp of another client => callback rejected, RT revoked", async () => {
    idp.idClaims = { azp: "other-client" };
    const s = await startLogin(idp);
    const res = await callback(idp, { code: "c1", state: s.state, iss: ISSUER }, { fea_tx: s.txCookie });
    expect(res.status).toBe(400);
    expect(setCookies(res).fea_sid).toBeUndefined();
    expect(idp.calls.revoke).toHaveLength(1);
  });

  it("single aud with azp = this client => accepted", async () => {
    idp.idClaims = { azp: "fe-admin" };
    expect((await signIn(idp)).sid).not.toBe("");
  });
});

describe("DEBT-296: forced refresh vs an ordinary refresh in flight", () => {
  // An ordinary refresh (liveSession saw an expiring AT) re-reads the session, finds it fresh and
  // hands back the SAME AT the admin API just refused. A forced caller waiting on it must not take
  // that AT, nor a second ordinary refresh that starts right after (it would return it again).
  // The second one lands in a microtask window, so every offset k is tried.
  it("never returns the rejected AT, never ends the session", async () => {
    const realGet = idp.store.get.bind(idp.store);
    const plan: Array<(p: Promise<SessionLookup>) => Promise<SessionLookup>> = [];
    idp.store.get = (k) => {
      const step = plan.shift();
      return step ? step(realGet(k)) : realGet(k);
    };
    const expiring = async (p: Promise<SessionLookup>): Promise<SessionLookup> => {
      const r = await p;
      return r.status === "ok" ? { ...r, data: { ...r.data, atExp: 0 } } : r;
    };
    const settle = () => new Promise((r) => setTimeout(r, 30));

    for (let k = 0; k < 12; k++) {
      const { sid } = await signIn(idp);
      const key = idp.store.keyFor(sid);
      const before = await realGet(key);
      if (before.status !== "ok") throw new Error("no session");
      const rejected = before.data.tokens.accessToken;
      const request = () => new Request(`${APP_URL}/clients`, { headers: { cookie: `fea_sid=${sid}` } });
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      plan.length = 0;
      plan.push(expiring); // A: liveSession => ordinary refresh R1
      plan.push(async (p) => {
        const r = await p;
        await held; // R1 re-read: fresh, returns the rejected AT
        return r;
      });
      const a = idp.auth.accessToken(request());
      await settle();
      const forced = idp.auth.refreshRejected(key, rejected); // waits on R1
      plan.push(async (p) => {
        const r = await expiring(p);
        await held;
        for (let i = 0; i < k; i++) await null;
        return r; // B: liveSession => ordinary refresh R2 once R1 is gone
      });
      const b = idp.auth.accessToken(request());
      await settle();
      release();
      const fresh = await forced;
      await Promise.all([a, b]);
      expect(fresh, `k=${k}`).not.toBeNull();
      expect(fresh, `k=${k}`).not.toBe(rejected);
      expect(await redis.exists(key), `k=${k}`).toBe(1);
    }
    expect(idp.calls.revoke).toEqual([]);
  });
});
