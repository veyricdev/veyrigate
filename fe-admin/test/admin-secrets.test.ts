// @vitest-environment node
// Run 45 F2: client secrets through the admin API client (fake admin API, real test Redis): fixed
// paths, DELETE/204, zod allowlist, and the plaintext never reaches a log or a typed failure.
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminApiError, createAdminApi, type AdminApi } from "@/server/admin-api/client";
import { connectTestRedis } from "./support/redis";
import { APP_URL, ISSUER, createFakeIdp, signIn, type AdminReply, type FakeIdp } from "./support/fake-idp";

const SECRET = "S3CR3T-canary-0123456789";

let redis: Redis;
let idp: FakeIdp;
let api: AdminApi;
let logged: string[];

beforeAll(async () => {
  redis = await connectTestRedis();
});
beforeEach(async () => {
  idp = await createFakeIdp(redis);
  api = createAdminApi({ baseUrl: `${ISSUER}/`, fetch: idp.fetch, auth: idp.auth, timeoutMs: 100 });
  logged = [];
  for (const level of ["error", "warn", "log", "info", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...a) => void logged.push(a.map(String).join(" ")));
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (idp.sessionKeys.size) await redis.del(...idp.sessionKeys);
});
afterAll(() => redis.disconnect());

async function ctx() {
  const { sid } = await signIn(idp);
  return {
    request: new Request(`${APP_URL}/clients/app-1`, { headers: { cookie: `fea_sid=${sid}` } }),
    setCookie: () => undefined,
  };
}
const reply = (r: AdminReply) => {
  idp.adminApi = () => r;
};
const failure = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected a failure");
    },
    (e: unknown) => e as AdminApiError,
  );

const ROW = { version: 2, createdAt: "2026-10-01T00:00:00.000Z", expiresAt: null, revokedAt: null, status: "active" };

describe("list", () => {
  it("GET /admin/clients/{id}/secrets: rows allowlisted (a hash or secret field is dropped)", async () => {
    reply({ status: 200, body: { items: [{ ...ROW, secretHash: "h", clientSecret: SECRET }], debug: 1 } });
    const list = await api.listSecrets(await ctx(), "a b");
    expect(list).toEqual({ items: [ROW] });
    expect(idp.calls.admin[0]!.method).toBe("GET");
    expect(idp.calls.admin[0]!.url.pathname).toBe("/admin/clients/a%20b/secrets");
  });

  it("unknown status => off contract (plain Error, not typed)", async () => {
    reply({ status: 200, body: { items: [{ ...ROW, status: "weird" }] } });
    const err = await failure(api.listSecrets(await ctx(), "app-1"));
    expect(err).not.toBeInstanceOf(AdminApiError);
  });
});

describe("issue", () => {
  it("POST without a body; the answer is allowlisted", async () => {
    reply({ status: 201, body: { clientId: "app-1", version: 3, clientSecret: SECRET, secretHash: "h" } });
    expect(await api.issueSecret(await ctx(), "app-1")).toEqual({ clientId: "app-1", version: 3, clientSecret: SECRET });
    const [call] = idp.calls.admin;
    expect(call!.method).toBe("POST");
    expect(call!.url.pathname).toBe("/admin/clients/app-1/secrets");
    expect(call!.body).toBeUndefined();
    expect(call!.headers.get("content-type")).toBeNull();
  });

  it.each([
    ["2xx off schema (secret too long)", { status: 201, body: { clientId: "app-1", version: 3, clientSecret: `${SECRET}${"x".repeat(600)}` } }],
    ["2xx off schema (version 0)", { status: 201, body: { clientId: "app-1", version: 0, clientSecret: SECRET } }],
    ["2xx non-JSON", { status: 201, raw: `{"clientSecret":"${SECRET}"` }],
    ["5xx with the secret in the body", { status: 500, body: { clientSecret: SECRET } }],
    ["timeout", "hang"],
  ] as const)("%s => unavailable + uncertain, sent once, the secret is in no log and no failure", async (_, r) => {
    reply(r as AdminReply);
    const err = await failure(api.issueSecret(await ctx(), "app-1"));
    expect(err).toBeInstanceOf(AdminApiError);
    expect(err.toFailure()).toMatchObject({ code: "unavailable", uncertain: true });
    expect(idp.calls.admin).toHaveLength(1);
    expect(logged.join("\n")).toMatch(/admin api POST \/admin\/clients\/:clientId\/secrets failed/);
    for (const text of [logged.join("\n"), err.message, String(err.stack), JSON.stringify(err.toFailure())]) {
      expect(text).not.toContain(SECRET);
    }
  });

  it.each([
    ["403 step_up_required", { status: 403, body: { error: "step_up_required" } }, "step_up_required"],
    ["403 forbidden (admin-capable, not super_admin)", { status: 403, body: { error: "forbidden" } }, "forbidden"],
    ["400 public client", { status: 400, body: { error: "invalid_request", error_description: "a public client has no secret" } }, "invalid_request"],
    ["404", { status: 404, body: { error: "not_found" } }, "not_found"],
  ] as const)("%s => typed failure", async (_, r, code) => {
    reply(r);
    const err = await failure(api.issueSecret(await ctx(), "app-1"));
    expect(err.code).toBe(code);
    expect(err.uncertain).toBeUndefined();
  });
});

describe("revoke (DELETE)", () => {
  it("204 => ok, nothing parsed; path = client + version", async () => {
    reply({ status: 204 });
    await expect(api.revokeSecret(await ctx(), "app-1", 7)).resolves.toBeUndefined();
    const [call] = idp.calls.admin;
    expect(call!.method).toBe("DELETE");
    expect(call!.url.pathname).toBe("/admin/clients/app-1/secrets/7");
    expect(call!.body).toBeUndefined();
  });

  it("404 => not_found (already revoked or unknown)", async () => {
    reply({ status: 404, body: { error: "not_found" } });
    expect((await failure(api.revokeSecret(await ctx(), "app-1", 7))).code).toBe("not_found");
  });

  it.each([
    ["timeout", "hang"],
    ["5xx", { status: 503, body: {} }],
    ["2xx other than 204", { status: 200, body: {} }],
  ] as const)("%s => unavailable + uncertain, sent once", async (_, r) => {
    reply(r as AdminReply);
    const err = await failure(api.revokeSecret(await ctx(), "app-1", 7));
    expect(err.toFailure()).toMatchObject({ code: "unavailable", uncertain: true });
    expect(idp.calls.admin).toHaveLength(1);
  });
});
