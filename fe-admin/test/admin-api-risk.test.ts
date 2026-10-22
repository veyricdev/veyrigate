// @vitest-environment node
// Tester risk matrix for the admin API client (run 43, tester): hostile path ids reach the BE as
// ONE encoded segment, raw BE bodies (long canary) never cross to the browser or the logs, the
// 401 chain ends the session for the NEXT request too, concurrent 401s on a dead RT end it once.
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminApiError, createAdminApi, type AdminApi } from "@/server/admin-api/client";
import { ClientIdSchema } from "@/features/admin-api/inputs";
import { connectTestRedis } from "./support/redis";
import { APP_URL, ISSUER, createFakeIdp, signIn, type AdminReply, type FakeIdp } from "./support/fake-idp";

let redis: Redis;
let idp: FakeIdp;
let api: AdminApi;
let logged: string[];

beforeAll(async () => {
  redis = await connectTestRedis();
});
beforeEach(async () => {
  idp = await createFakeIdp(redis);
  api = createAdminApi({ baseUrl: ISSUER, fetch: idp.fetch, auth: idp.auth, timeoutMs: 100 });
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...a) => void logged.push(a.map(String).join(" ")));
  vi.spyOn(console, "warn").mockImplementation((...a) => void logged.push(a.map(String).join(" ")));
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (idp.sessionKeys.size) await redis.del(...idp.sessionKeys);
});
afterAll(() => redis.disconnect());

const BE_CLIENT = {
  clientId: "app-1",
  tenantId: "t1",
  clientType: "confidential",
  tokenEndpointAuthMethod: "client_secret_basic",
  grantTypes: ["authorization_code"],
  redirectUris: ["https://app.example/cb"],
  postLogoutRedirectUris: [],
  frontchannelLogoutUri: null,
  allowedCorsOrigins: [],
  allowedResources: [],
  scopes: ["openid"],
  disabled: false,
  disabledAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: null,
};

async function session() {
  const { sid } = await signIn(idp);
  const key = idp.store.keyFor(sid);
  const stored = await idp.store.get(key);
  if (stored.status !== "ok") throw new Error("no session");
  const cookies: string[] = [];
  const ctx = {
    request: new Request(`${APP_URL}/clients`, { headers: { cookie: `fea_sid=${sid}` } }),
    setCookie: (c: string) => void cookies.push(c),
  };
  return { sid, key, ctx, cookies, at: stored.data.tokens.accessToken, rt: stored.data.tokens.refreshToken };
}
const failure = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected a failure");
    },
    (e: unknown) => e,
  );
const reply = (r: AdminReply) => {
  idp.adminApi = () => r;
};
const refreshGrants = () => idp.calls.token.filter((f) => f.get("grant_type") === "refresh_token");

describe("hostile client ids that pass the schema stay ONE encoded path segment", () => {
  it.each([
    "%2F..%2Fadmin%2Fusers",
    "%2e%2e",
    "..%5c..",
    "...",
    "a?b=1&c#frag",
    "ứng-dụng-ünïcødé-🚀",
    "∕etc∕passwd", // division slash, not '/'
    "．．", // full-width dots
    "a\u0000b\r\nX-Injected: 1",
    "x".repeat(128),
  ])("%j", async (id) => {
    expect(ClientIdSchema.safeParse(id).success).toBe(true);
    const s = await session();
    reply({ status: 200, body: { ...BE_CLIENT, clientId: id } });
    await api.getClient(s.ctx, id);
    await api.updateClient(s.ctx, id, { disabled: true });
    expect(idp.calls.admin).toHaveLength(2);
    for (const call of idp.calls.admin) {
      expect(call.url.origin).toBe(ISSUER);
      expect(call.url.search).toBe("");
      expect(call.url.hash).toBe("");
      const segments = call.url.pathname.split("/");
      expect(segments.slice(0, 3)).toEqual(["", "admin", "clients"]);
      expect(segments).toHaveLength(4);
      expect(decodeURIComponent(segments[3]!)).toBe(id);
      expect(call.headers.get("x-injected")).toBeNull();
    }
  });

  it.each(["../x", "..", ".", "a/b", "a\\b", "", "x".repeat(129), "ü".repeat(129)])(
    "%j is refused by the schema",
    (id) => {
      expect(ClientIdSchema.safeParse(id).success).toBe(false);
    },
  );

  it("list cursor with reserved chars stays inside the query (no extra param, no path change)", async () => {
    const s = await session();
    reply({ status: 200, body: { items: [], nextCursor: null } });
    await api.listClients(s.ctx, { after: "x&limit=1000#/../../admin/users" });
    const [call] = idp.calls.admin;
    expect(call!.url.pathname).toBe("/admin/clients");
    expect([...call!.url.searchParams.keys()]).toEqual(["after"]);
    expect(call!.url.searchParams.get("after")).toBe("x&limit=1000#/../../admin/users");
  });
});

describe("raw BE bodies never cross to the browser or the logs (long canary)", () => {
  const CANARY = `BE-RAW-CANARY-${"Z".repeat(20_000)}`;

  it.each([
    ["500 JSON", { status: 500, body: { error: "server_error", error_description: CANARY, stack: CANARY } }, "unavailable"],
    ["502 raw", { status: 502, raw: CANARY }, "unavailable"],
    ["302 raw", { status: 302, raw: CANARY }, "unavailable"],
    ["403 step_up", { status: 403, body: { error: "step_up_required", error_description: CANARY } }, "step_up_required"],
    ["403 forbidden", { status: 403, body: { error: "forbidden", error_description: CANARY } }, "forbidden"],
    ["404", { status: 404, body: { error: "not_found", error_description: CANARY } }, "not_found"],
    ["403 raw", { status: 403, raw: CANARY }, "unavailable"],
  ] as const)("%s => fixed message, no canary", async (_, r, code) => {
    const s = await session();
    reply(r);
    const err = (await failure(api.updateClient(s.ctx, "app-1", { scopes: [] }))) as AdminApiError;
    expect(err).toBeInstanceOf(AdminApiError);
    expect(err.code).toBe(code);
    const wire = JSON.stringify(err.toFailure());
    expect(wire.length).toBeLessThan(200);
    for (const text of [wire, err.message, logged.join("\n")]) {
      expect(text).not.toContain("BE-RAW-CANARY");
      expect(text).not.toContain(s.at);
    }
  });

  it("400/409 description: only the first 200 chars cross; non-string description => fixed text", async () => {
    const s = await session();
    reply({ status: 409, body: { error: "conflict", error_description: `${"d".repeat(200)}${CANARY}` } });
    const err = (await failure(api.updateClient(s.ctx, "app-1", { scopes: [] }))) as AdminApiError;
    expect(err.message).toBe("d".repeat(200));
    expect(JSON.stringify(err.toFailure())).not.toContain("CANARY");
    reply({ status: 400, body: { error: "invalid_request", error_description: { html: CANARY } } });
    const err2 = (await failure(api.updateClient(s.ctx, "app-1", { scopes: [] }))) as AdminApiError;
    expect(err2.message).toBe("The request was rejected.");
  });

  it("unknown status with a canary body => plain Error whose message has no body", async () => {
    const s = await session();
    reply({ status: 451, body: { error: CANARY, error_description: CANARY } });
    const err = (await failure(api.getClient(s.ctx, "app-1"))) as Error;
    expect(err).not.toBeInstanceOf(AdminApiError);
    expect(err.message).not.toContain("CANARY");
  });

  it("2xx response with extra secret-ish fields: stripped by the allowlist", async () => {
    const s = await session();
    reply({ status: 200, body: { ...BE_CLIENT, secretHash: CANARY, clientSecret: CANARY, accessToken: CANARY } });
    const out = await api.getClient(s.ctx, "app-1");
    expect(JSON.stringify(out)).not.toContain("CANARY");
  });
});

describe("401 chain: the session is over for the next request too", () => {
  it("401 -> refresh -> 401 => destroyed; the NEXT call with the same cookie never reaches the BE", async () => {
    const s = await session();
    idp.adminApi = () => ({ status: 401, body: { error: "invalid_token" } });
    expect(((await failure(api.getClient(s.ctx, "app-1"))) as AdminApiError).code).toBe("unauthenticated");
    expect(idp.calls.admin).toHaveLength(2);
    expect(refreshGrants()).toHaveLength(1);
    // Browser ignored the clearing Set-Cookie (or replays the old cookie): still refused, no BE call, no refresh.
    const cookies: string[] = [];
    const replay = { request: s.ctx.request, setCookie: (c: string) => void cookies.push(c) };
    idp.adminApi = () => ({ status: 200, body: BE_CLIENT });
    expect(((await failure(api.getClient(replay, "app-1"))) as AdminApiError).code).toBe("unauthenticated");
    expect(idp.calls.admin).toHaveLength(2);
    expect(refreshGrants()).toHaveLength(1);
    expect(cookies).toEqual([expect.stringMatching(/^fea_sid=; .*Max-Age=0/)]);
  });

  it("403 step_up_required after a successful 401 refresh => step_up_required, still exactly one refresh", async () => {
    const s = await session();
    idp.adminApi = (r) =>
      r.headers.get("authorization") === `Bearer ${s.at}`
        ? { status: 401, body: { error: "invalid_token" } }
        : { status: 403, body: { error: "step_up_required", max_age: 0 } };
    const err = (await failure(api.updateClient(s.ctx, "app-1", { scopes: [] }))) as AdminApiError;
    expect(err.code).toBe("step_up_required");
    expect(refreshGrants()).toHaveLength(1);
    expect(idp.calls.admin).toHaveLength(2);
    expect(await redis.exists(s.key)).toBe(1); // step-up never ends the session
    expect(s.cookies).toEqual([]);
  });

  it("step_up_required repeated many times never triggers a refresh", async () => {
    const s = await session();
    reply({ status: 403, body: { error: "step_up_required", max_age: 0 } });
    for (let i = 0; i < 5; i++) await failure(api.updateClient(s.ctx, "app-1", { scopes: [] }));
    expect(refreshGrants()).toHaveLength(0);
    expect(idp.calls.admin).toHaveLength(5);
  });

  it("concurrent: 3 parallel calls, the BE refuses every token => 1 refresh grant, all unauthenticated, session gone", async () => {
    const s = await session();
    idp.adminApi = () => ({ status: 401, body: { error: "invalid_token" } });
    const results = await Promise.all([
      failure(api.getClient(s.ctx, "a")),
      failure(api.getClient(s.ctx, "b")),
      failure(api.updateClient(s.ctx, "c", { scopes: [] })),
    ]);
    for (const e of results) expect((e as AdminApiError).code).toBe("unauthenticated");
    expect(refreshGrants()).toHaveLength(1);
    expect(await redis.exists(s.key)).toBe(0);
    // A replayed rotated/old RT would revoke the whole family at the real IdP: never sent twice.
    const sentRts = refreshGrants().map((f) => f.get("refresh_token"));
    expect(new Set(sentRts).size).toBe(sentRts.length);
  });

  it("5xx on a mutation => uncertain; 5xx on a GET => not uncertain (504 / 599)", async () => {
    const s = await session();
    reply({ status: 504, raw: "" });
    expect(((await failure(api.updateClient(s.ctx, "app-1", { scopes: [] }))) as AdminApiError).uncertain).toBe(true);
    reply({ status: 599, body: {} });
    expect(((await failure(api.getClient(s.ctx, "app-1"))) as AdminApiError).uncertain).toBeUndefined();
    expect(idp.calls.admin).toHaveLength(2); // no BFF retry
  });
});
