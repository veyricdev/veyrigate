// @vitest-environment node
// Run 48 (A6.4) tester risk matrix, audit server function (same harness as audit-fn.test.ts: REAL
// adminCall + admin API client, only the BE fetch/session/Start faked): hostile metadata keys and
// values (prototype keys, secret-looking variants, deep objects), prototype-key and coercion inputs
// to the validator, top-level leaks, and the query string never carrying more than the input.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const beFetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

vi.mock("@tanstack/react-start", () => ({
  createServerFn: (opts: { method: string }) => ({
    inputValidator: (schema: { parse: (v: unknown) => unknown }) => ({
      handler: (fn: (o: { data: unknown }) => unknown) =>
        Object.assign(async (o: { data: unknown }) => fn({ data: schema.parse(o.data) }), { method: opts.method }),
    }),
  }),
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("http://localhost:3000/audit"),
  getResponseHeaders: () => new Headers(),
}));
vi.mock("@/server/env", () => ({
  serverEnv: () => ({ ADMIN_API_BASE_URL: "http://idp.test", OIDC_ISSUER: "http://idp.test" }),
}));
vi.mock("@/server/auth/instance", () => ({
  getAuth: () => ({
    accessToken: async () => ({ session: { key: "k", token: "at" } }),
    refreshRejected: async () => null,
    dropSession: async () => "fea_sid=; Max-Age=0",
  }),
}));

type Fn = ((o: { data: unknown }) => Promise<unknown>) & { method: string };
let listAudit: Fn;
let logged: string[];

beforeEach(async () => {
  beFetch.mockReset();
  vi.stubGlobal("fetch", beFetch);
  logged = [];
  for (const level of ["error", "warn", "log", "info", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...a) => void logged.push(a.map(String).join(" ")));
  }
  ({ listAudit } = (await import("@/features/admin-api/audit")) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const EVENT = {
  eventId: "e-1",
  timestamp: "2026-10-23T01:02:03.004Z",
  actorType: "admin",
  actorId: "a".repeat(24),
  action: "ADMIN_USER_LOCKED",
  targetType: "user",
  targetId: "b".repeat(24),
  result: "success",
  metadata: { count: 2 },
};
const page = (items: unknown[], nextCursor: string | null = null) => json(200, { items, nextCursor });

describe("tester: hostile metadata is filtered server-side", () => {
  it("__proto__ / constructor keys from JSON never pollute and never smuggle an object", async () => {
    beFetch.mockResolvedValue(
      new Response(
        '{"items":[{"eventId":"e","timestamp":"t","actorType":"admin","action":"X","result":"success",' +
          '"metadata":{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"p":1}},"familyId":"f"}}],"nextCursor":null}',
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const out = (await listAudit({ data: {} })) as { ok: true; data: { items: { metadata: Record<string, unknown> }[] } };
    expect(out.ok).toBe(true);
    const md = out.data.items[0]!.metadata;
    expect(Object.keys(md)).toEqual(["familyId"]);
    expect(Object.getPrototypeOf(md)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).p).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("polluted");
  });

  it.each([
    "access_token",
    "idToken",
    "ID-TOKEN",
    "X-Api-Secret",
    "PASSWORD",
    "passwordHash",
    "pkce_verifier",
    "Set-Cookie",
    "Authorization",
    "private_key",
    "code",
    "auth-code".replace("auth-", "authorization_"),
    "sha256Hash",
    "refreshTokenHash",
  ])("secret-looking key %j is dropped (value never reaches the browser)", async (key) => {
    beFetch.mockResolvedValue(page([{ ...EVENT, metadata: { [key]: "leak-canary", count: 1 } }]));
    const out = (await listAudit({ data: {} })) as { ok: true; data: { items: { metadata: unknown }[] } };
    expect(out.data.items[0]!.metadata).toEqual({ count: 1 });
    expect(JSON.stringify(out)).not.toContain("leak-canary");
  });

  it("every BE metadata key in use today survives (denylist does not over-filter)", async () => {
    const md = {
      addedRoles: "a",
      removedRoles: "b",
      clientId: "app-1",
      resource: "r",
      count: 1,
      clientType: "public",
      failedStep: "pre_revoke",
      familyId: "f",
      identifier: "https://api/",
      scopeCount: 2,
      mode: "emergency",
      oldKid: "k",
      outcome: "o",
      provider: "google",
      newUser: true,
      reason: "admin_granted",
      scope: "all",
      refresh: false,
      version: 3,
    };
    beFetch.mockResolvedValue(page([{ ...EVENT, metadata: md }]));
    const out = (await listAudit({ data: {} })) as { ok: true; data: { items: { metadata: unknown }[] } };
    expect(out.data.items[0]!.metadata).toEqual(md);
  });

  it("object/array/function-like values are dropped; HTML and javascript: strings stay plain strings", async () => {
    beFetch.mockResolvedValue(
      page([
        {
          ...EVENT,
          metadata: {
            obj: { toString: "x" },
            arr: ["<script>"],
            deep: { a: { b: { c: "secret" } } },
            html: "<img src=x onerror=alert(1)>",
            js: "javascript:alert(1)",
            big: 1e308,
          },
        },
      ]),
    );
    const out = (await listAudit({ data: {} })) as { ok: true; data: { items: { metadata: unknown }[] } };
    expect(out.data.items[0]!.metadata).toEqual({
      html: "<img src=x onerror=alert(1)>",
      js: "javascript:alert(1)",
      big: 1e308,
    });
  });

  it("a top-level field of the wrong type fails closed (no partial page), nothing logged with the value", async () => {
    beFetch.mockResolvedValue(page([{ ...EVENT, ip: { forwarded: "leak-canary" } }]));
    // A GET off contract is a bug, not an outage: it throws (generic 500), never a partial page.
    const err = await listAudit({ data: {} }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/response schema mismatch/);
    expect(String(err?.message) + String(err?.stack)).not.toContain("leak-canary");
    expect(logged.join("\n")).not.toContain("leak-canary");
  });

  it("top-level tenantId/_id/__v/passwordHash and unknown keys never reach the browser", async () => {
    beFetch.mockResolvedValue(
      page([{ ...EVENT, tenantId: "t-canary", _id: "id-canary", __v: 0, passwordHash: "ph-canary", sessionId: "sid-canary" }]),
    );
    const text = JSON.stringify(await listAudit({ data: {} }));
    for (const leak of ["t-canary", "id-canary", "__v", "ph-canary", "sid-canary"]) expect(text).not.toContain(leak);
  });
});

describe("tester: the validator (prototype keys, coercion, boundaries)", () => {
  it.each([
    ["an own __proto__ key", JSON.parse('{"__proto__":{"tenantId":"t2"}}')],
    ["an own constructor key", JSON.parse('{"constructor":{"tenantId":"t2"}}')],
    ["a tenant_id key", { tenant_id: "t2" }],
    ["limit as a string", { limit: "20" }],
    ["limit 101", { limit: 101 }],
    ["limit 1.5", { limit: 1.5 }],
    ["an id as a number", { actorId: 12 }],
    ["an id as an array", { targetId: ["a"] }],
    ["a 513-char cursor", { after: "a".repeat(513) }],
    ["a cursor with '='", { after: "eyJ0IjoxfQ==" }],
    ["a URL-encoded email", { actorId: "a%40b.c" }],
    ["a newline in an id", { clientId: "a\nb" }],
    ["a unicode homoglyph", { actorId: "a＠b" }],
    ["a time without offset", { from: "2026-10-01T00:00:00" }],
    ["an action in lower case", { action: "token_reuse_detected" }],
    ["null input", null],
  ])("%s is refused before any BE call", async (_, data) => {
    await expect(listAudit({ data })).rejects.toThrow();
    expect(beFetch).not.toHaveBeenCalled();
  });

  it("an attacker-shaped cursor that passes the charset reaches the BE only as one encoded param", async () => {
    beFetch.mockResolvedValue(json(400, { error: "invalid_request", error_description: "invalid cursor" }));
    const out = await listAudit({ data: { after: "eyJ0IjoxLCJlIjoieCJ9-_", action: "TOKEN_REUSE_DETECTED" } });
    const url = new URL(beFetch.mock.calls[0]![0]);
    expect([...url.searchParams.keys()]).toEqual(["after", "action"]);
    expect(url.searchParams.get("tenantId")).toBeNull();
    expect(out).toEqual({ ok: false, error: { code: "invalid_request", message: "invalid cursor" } });
  });

  it("the BE request carries the admin bearer only, no cookie and no body", async () => {
    beFetch.mockResolvedValue(page([]));
    await listAudit({ data: { targetId: "u-1" } });
    const [, init] = beFetch.mock.calls[0]!;
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer at");
    expect(headers.get("cookie")).toBeNull();
    expect(init.body).toBeUndefined();
  });
});
