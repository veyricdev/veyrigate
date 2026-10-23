// @vitest-environment node
// Run 48 F2: the audit server function through the REAL `adminCall` + admin API client (only the
// BE fetch, the session and Start's request/response are faked): GET with an encoded query, the
// response allowlist + server-side metadata filter, and the input validator refusing an email, a
// space, a reversed range or an unknown key (e.g. `tenantId`) before any BE call.
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

describe("listAudit", () => {
  it("is a GET server function (its input may be in a URL: no email passes the validator)", () => {
    expect(listAudit.method).toBe("GET");
  });

  it("GET /admin/audit with every filter encoded, in input order; logs nothing", async () => {
    beFetch.mockResolvedValue(page([EVENT], "eyJ0IjoxfQ"));
    const out = await listAudit({
      data: {
        limit: 20,
        after: "eyJ0IjoxfQ",
        action: "TOKEN_REUSE_DETECTED",
        actorId: "u:1",
        targetType: "signing_key",
        targetId: "kid.2026-10_x",
        clientId: "app-1",
        result: "failure",
        from: "2026-10-01T00:00:00.000Z",
        to: "2026-10-23T10:00:00+07:00",
      },
    });
    const [url, init] = beFetch.mock.calls[0]!;
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(url).toBe(
      "http://idp.test/admin/audit?limit=20&after=eyJ0IjoxfQ&action=TOKEN_REUSE_DETECTED&actorId=u%3A1" +
        "&targetType=signing_key&targetId=kid.2026-10_x&clientId=app-1&result=failure" +
        "&from=2026-10-01T00%3A00%3A00.000Z&to=2026-10-23T10%3A00%3A00%2B07%3A00",
    );
    expect(out).toEqual({ ok: true, data: { items: [EVENT], nextCursor: "eyJ0IjoxfQ" } });
    expect(logged).toEqual([]);
  });

  it("no params: no query string", async () => {
    beFetch.mockResolvedValue(page([]));
    await listAudit({ data: {} });
    expect(beFetch.mock.calls[0]![0]).toBe("http://idp.test/admin/audit");
  });

  it("only allowlisted fields and safe metadata reach the browser", async () => {
    beFetch.mockResolvedValue(
      page([
        {
          ...EVENT,
          tenantId: "t-secret",
          _id: "mongo-id",
          secretHash: "$argon2id$x",
          ip: "203.0.113.9",
          userAgent: "<script>alert(1)</script>",
          requestId: "req-1",
          reason: "r",
          metadata: {
            clientSecret: "s3cr3t",
            refresh_token: "rt-value",
            codeVerifier: "v-value",
            tokenHash: "h-value",
            "pass-word": "p-value",
            Code: "c-value",
            authorization_code: "ac-value",
            privateKey: "pk-value",
            session_cookie: "ck-value",
            nested: { a: 1 },
            list: [1],
            familyId: "f",
            count: 2,
            ok: true,
            none: null,
          },
        },
      ]),
    );
    const out = (await listAudit({ data: {} })) as { ok: true; data: { items: Record<string, unknown>[] } };
    const [item] = out.data.items;
    expect(Object.keys(item!).sort()).toEqual(
      [
        "action",
        "actorId",
        "actorType",
        "eventId",
        "ip",
        "metadata",
        "reason",
        "requestId",
        "result",
        "targetId",
        "targetType",
        "timestamp",
        "userAgent",
      ].sort(),
    );
    expect(item!.metadata).toEqual({ familyId: "f", count: 2, ok: true, none: null });
    const text = JSON.stringify(out);
    for (const leak of ["t-secret", "mongo-id", "argon2", "s3cr3t", "-value", "nested", "list"]) {
      expect(text).not.toContain(leak);
    }
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["only secret / nested keys", { token: "x", nested: { a: 1 } }],
    ["an array", [1, 2]],
    ["a string", "oops"],
  ])("metadata %s => null, the page still loads", async (_, metadata) => {
    const { metadata: _drop, ...base } = EVENT;
    beFetch.mockResolvedValue(page([metadata === undefined ? base : { ...base, metadata }]));
    const out = (await listAudit({ data: {} })) as { ok: true; data: { items: { metadata: unknown }[] } };
    expect(out.ok).toBe(true);
    expect(out.data.items[0]!.metadata).toBeNull();
  });

  it("an action or actorType the FE does not know does not break the page", async () => {
    beFetch.mockResolvedValue(page([{ ...EVENT, action: "SOMETHING_NEW", actorType: "robot" }]));
    const out = (await listAudit({ data: {} })) as { ok: true; data: { items: { action: string }[] } };
    expect(out.data.items[0]!.action).toBe("SOMETHING_NEW");
  });

  it("400 invalid cursor => invalid_request with the BE description", async () => {
    beFetch.mockResolvedValue(json(400, { error: "invalid_request", error_description: "invalid cursor" }));
    expect(await listAudit({ data: { after: "bad" } })).toEqual({
      ok: false,
      error: { code: "invalid_request", message: "invalid cursor" },
    });
  });

  it("5xx => unavailable, not uncertain (a read)", async () => {
    beFetch.mockResolvedValue(json(503, {}));
    expect(await listAudit({ data: {} })).toEqual({
      ok: false,
      error: { code: "unavailable", message: expect.any(String) },
    });
  });
});

describe("the input validator refuses before any BE call", () => {
  it.each([
    ["an email as actorId", { actorId: "a@b.c" }],
    ["an email as targetId", { targetId: "canary.user+x@example.com" }],
    ["an email as clientId", { clientId: "x@y" }],
    ["an id with a space", { targetId: "a b" }],
    ["an empty id", { actorId: "" }],
    ["a 129-char id", { targetId: "a".repeat(129) }],
    ["from > to", { from: "2026-10-02T00:00:00Z", to: "2026-10-01T00:00:00Z" }],
    ["from == to", { from: "2026-10-02T00:00:00Z", to: "2026-10-02T00:00:00Z" }],
    ["a non-ISO time", { from: "yesterday" }],
    ["an unknown action", { action: "DROP_TABLE" }],
    ["an unknown targetType", { targetType: "tenant" }],
    ["an unknown result", { result: "maybe" }],
    ["a cursor with '/'", { after: "a/b" }],
    ["a tenantId", { tenantId: "t2" }],
    ["an unknown key", { email: "a@b.c" }],
    ["limit 0", { limit: 0 }],
  ])("%s", async (_, data) => {
    await expect(listAudit({ data })).rejects.toThrow();
    expect(beFetch).not.toHaveBeenCalled();
  });

  it("a 128-char id with every allowed character is accepted", async () => {
    beFetch.mockResolvedValue(page([]));
    await listAudit({ data: { targetId: `Az09._:-${"x".repeat(120)}` } });
    expect(beFetch).toHaveBeenCalledOnce();
  });
});
