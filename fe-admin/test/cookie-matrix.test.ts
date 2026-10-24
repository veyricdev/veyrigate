// @vitest-environment node
// A7 (run 51 F3): every BFF Set-Cookie through the real flows, http and https APP_URL. Always
// HttpOnly, SameSite=Lax (Strict would drop fea_tx on the IdP's top-level redirect back), Path=/,
// host-only (no Domain); https adds Secure and the __Host- prefix. Fake IdP + real test Redis.
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cookieNames } from "@/server/session/cookies";
import { connectTestRedis } from "./support/redis";
import { ISSUER, callback, createFakeIdp, type FakeIdp } from "./support/fake-idp";

let redis: Redis;
let idp: FakeIdp;

beforeAll(async () => {
  redis = await connectTestRedis();
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (idp.sessionKeys.size) await redis.del(...idp.sessionKeys);
});
afterAll(() => redis.disconnect());

describe.each(["http://localhost:3000", "https://admin.example.com"])("APP_URL %s", (appUrl) => {
  const names = cookieNames(appUrl);
  const secure = appUrl.startsWith("https:");

  beforeEach(async () => {
    idp = await createFakeIdp(redis, appUrl);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  /** The one Set-Cookie for `name`, checked against the role-independent attribute rules. */
  function cookie(res: Response, name: string): string[] {
    const all = res.headers.getSetCookie().filter((c) => c.startsWith(`${name}=`));
    expect(all).toHaveLength(1);
    const attrs = all[0]!.split(";").map((p) => p.trim());
    expect(attrs).toEqual(expect.arrayContaining(["HttpOnly", "SameSite=Lax", "Path=/"]));
    expect(attrs.some((p) => /^domain=/i.test(p))).toBe(false);
    expect(attrs.includes("Secure")).toBe(secure);
    expect(name.startsWith("__Host-")).toBe(secure);
    return attrs;
  }
  const value = (attrs: string[]) => attrs[0]!.slice(attrs[0]!.indexOf("=") + 1);

  async function signIn() {
    const login = await idp.auth.login(new Request(`${appUrl}/auth/login`));
    const tx = cookie(login, names.tx);
    expect(tx).toContain("Max-Age=600");
    const authorize = new URL(login.headers.get("location")!);
    idp.nonce = authorize.searchParams.get("nonce")!;
    const res = await callback(
      idp,
      { code: "c1", state: authorize.searchParams.get("state")!, iss: ISSUER },
      { [names.tx]: value(tx) },
    );
    expect(res.status).toBe(302);
    return res;
  }

  it("login sets tx; callback sets sid and clears tx", async () => {
    const res = await signIn();
    const sid = cookie(res, names.sid);
    expect(value(sid)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sid.some((p) => /^(max-age|expires)=/i.test(p))).toBe(false);
    expect(cookie(res, names.tx)).toContain("Max-Age=0");
  });

  it("logout clears sid", async () => {
    const sid = value(cookie(await signIn(), names.sid));
    const res = await idp.auth.logout(
      new Request(`${appUrl}/auth/logout`, {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin", cookie: `${names.sid}=${sid}` },
      }),
    );
    expect(res.status).toBe(303);
    expect(cookie(res, names.sid)).toContain("Max-Age=0");
  });

  it("viewer with a dead session clears sid", async () => {
    const { viewer, setCookie } = await idp.auth.viewer(
      new Request(`${appUrl}/`, { headers: { cookie: `${names.sid}=${"x".repeat(43)}` } }),
    );
    expect(viewer).toBeNull();
    const res = new Response(null, { headers: [["set-cookie", setCookie!]] });
    expect(cookie(res, names.sid)).toContain("Max-Age=0");
  });
});
