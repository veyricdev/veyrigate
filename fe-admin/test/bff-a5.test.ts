// @vitest-environment node
// Run 43: an unreachable IdP is a dead dependency (503, DEBT-289) while a wrong discovery document
// stays a 500 (configuration, fail-closed); `azp` with a single `aud` (OIDC Core §3.1.3.7).
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceUnavailableError, withErrorPage } from "@/server/errors";
import { createDiscovery } from "@/server/oidc/discovery";
import { connectTestRedis } from "./support/redis";
import { APP_URL, ISSUER, callback, createFakeIdp, setCookies, signIn, startLogin, type FakeIdp } from "./support/fake-idp";

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
