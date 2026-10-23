// @vitest-environment node
// Run 47 F2: the user server functions through the REAL `adminCall` + admin API client (only the
// BE fetch, the session and Start's request/response are faked): fixed endpoints, error codes,
// `uncertain` for writes only, allowlisted views, input validators before any BE call, and the
// email filter kept out of every URL (POST server function) and every log line.
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
  getRequest: () => new Request("http://localhost:3000/users"),
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
type Fns = Record<
  | "listUsers"
  | "getUser"
  | "listUserFamilies"
  | "listUserConsents"
  | "lockUser"
  | "unlockUser"
  | "revokeUserSessions"
  | "revokeUserFamily"
  | "revokeUserConsent",
  Fn
>;
let fns: Fns;
let logged: string[];

beforeEach(async () => {
  beFetch.mockReset();
  vi.stubGlobal("fetch", beFetch);
  logged = [];
  for (const level of ["error", "warn", "log", "info", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...a) => void logged.push(a.map(String).join(" ")));
  }
  fns = (await import("@/features/admin-api/users")) as never;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ID = "a".repeat(24);
const EMAIL = "canary.user+x@example.com";
const USER = {
  id: ID,
  email: "u@example.com",
  emailVerified: true,
  locked: false,
  lockedUntil: null,
  membershipStatus: "active",
  roles: [],
  createdAt: "2026-01-01T00:00:00.000Z",
};
const FAMILY = {
  familyId: "fam-1",
  clientId: "c1",
  resource: "https://api.example.com/",
  scope: ["openid"],
  createdAt: "2026-01-01T00:00:00.000Z",
  lastRotatedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-02-01T00:00:00.000Z",
  active: true,
  revokedAt: null,
};
const CONSENT = {
  id: "b".repeat(24),
  clientId: "c1",
  resource: "https://api.example.com/",
  grantedScopes: ["openid"],
  policyVersion: null,
  termsVersion: "1",
  grantedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const call = (i = 0) => {
  const [url, init] = beFetch.mock.calls[i]!;
  return { url, method: init.method, body: init.body };
};

/** Every write with a valid input. */
const WRITES = () =>
  [
    ["lockUser", fns.lockUser, ID],
    ["unlockUser", fns.unlockUser, ID],
    ["revokeUserSessions", fns.revokeUserSessions, ID],
    ["revokeUserFamily", fns.revokeUserFamily, { userId: ID, familyId: "fam-1" }],
    ["revokeUserConsent", fns.revokeUserConsent, { userId: ID, consentId: CONSENT.id }],
  ] as const;

describe("server function methods", () => {
  it("listUsers is a POST server function (its input never goes into a URL); id-only reads stay GET", () => {
    expect(fns.listUsers.method).toBe("POST");
    expect([fns.getUser, fns.listUserFamilies, fns.listUserConsents].map((f) => f.method)).toEqual(["GET", "GET", "GET"]);
    for (const [, fn] of WRITES()) expect(fn.method).toBe("POST");
  });
});

describe("endpoints", () => {
  it("listUsers: GET /admin/users with limit, after, email, status encoded; logs only the template", async () => {
    beFetch.mockResolvedValue(json(200, { items: [USER], nextCursor: "c".repeat(24) }));
    expect(await fns.listUsers({ data: { limit: 20, after: "c".repeat(24), email: ` ${EMAIL} `, status: "suspended" } })).toEqual({
      ok: true,
      data: { items: [USER], nextCursor: "c".repeat(24) },
    });
    expect(call()).toMatchObject({
      method: "GET",
      url: `http://idp.test/admin/users?limit=20&after=${"c".repeat(24)}&email=canary.user%2Bx%40example.com&status=suspended`,
    });
  });

  it("listUsers without params: no query string", async () => {
    beFetch.mockResolvedValue(json(200, { items: [], nextCursor: null }));
    await fns.listUsers({ data: {} });
    expect(call().url).toBe("http://idp.test/admin/users");
  });

  it("getUser / families / consents: GET with the id in the path and the page query", async () => {
    beFetch.mockResolvedValueOnce(json(200, USER));
    expect(await fns.getUser({ data: ID })).toEqual({ ok: true, data: USER });
    beFetch.mockResolvedValueOnce(json(200, { items: [FAMILY], nextCursor: "fam-1" }));
    expect(await fns.listUserFamilies({ data: { userId: ID, limit: 20, after: "fam 1/x" } })).toEqual({
      ok: true,
      data: { items: [FAMILY], nextCursor: "fam-1" },
    });
    beFetch.mockResolvedValueOnce(json(200, { items: [CONSENT], nextCursor: null }));
    expect(await fns.listUserConsents({ data: { userId: ID } })).toEqual({ ok: true, data: { items: [CONSENT], nextCursor: null } });
    expect(beFetch.mock.calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      `GET http://idp.test/admin/users/${ID}`,
      `GET http://idp.test/admin/users/${ID}/families?limit=20&after=fam+1%2Fx`,
      `GET http://idp.test/admin/users/${ID}/consents`,
    ]);
  });

  it("writes: fixed method + path, no body, sent once", async () => {
    const expected = [
      `POST http://idp.test/admin/users/${ID}/lock`,
      `POST http://idp.test/admin/users/${ID}/unlock`,
      `POST http://idp.test/admin/users/${ID}/sessions/revoke`,
      `POST http://idp.test/admin/users/${ID}/families/fam-1/revoke`,
      `DELETE http://idp.test/admin/users/${ID}/consents/${CONSENT.id}`,
    ];
    for (const [i, [name, fn, data]] of WRITES().entries()) {
      beFetch.mockReset();
      beFetch.mockResolvedValue(name.endsWith("lockUser") ? json(200, USER) : new Response(null, { status: 204 }));
      const result = await fn({ data });
      expect(result).toEqual({ ok: true, data: name.endsWith("lockUser") ? USER : undefined });
      expect(beFetch).toHaveBeenCalledTimes(1);
      expect(`${call().method} ${call().url}`).toBe(expected[i]);
      expect(call().body).toBeUndefined();
    }
  });
});

describe("allowlist (zod strip)", () => {
  it("unknown BE fields never reach the result", async () => {
    const extra = { passwordHash: "$argon2id$canary", failedLoginCount: 4, tokenHash: "th-canary", sessionRef: "sr" };
    beFetch.mockResolvedValueOnce(json(200, { items: [{ ...USER, ...extra }], nextCursor: null }));
    beFetch.mockResolvedValueOnce(json(200, { ...USER, ...extra }));
    beFetch.mockResolvedValueOnce(json(200, { items: [{ ...FAMILY, ...extra }], nextCursor: null }));
    beFetch.mockResolvedValueOnce(json(200, { items: [{ ...CONSENT, ...extra }], nextCursor: null }));
    beFetch.mockResolvedValueOnce(json(200, { ...USER, ...extra }));
    const results = [
      await fns.listUsers({ data: {} }),
      await fns.getUser({ data: ID }),
      await fns.listUserFamilies({ data: { userId: ID } }),
      await fns.listUserConsents({ data: { userId: ID } }),
      await fns.lockUser({ data: ID }),
    ];
    const text = JSON.stringify(results);
    for (const key of Object.keys(extra)) expect(text).not.toContain(key);
    expect(text).not.toContain("canary");
  });
});

describe("error codes (BE wire shape)", () => {
  it.each([
    [400, { error: "invalid_request", error_description: "invalid cursor" }, "invalid_request"],
    [403, { error: "forbidden" }, "forbidden"],
    [403, { error: "step_up_required", max_age: 0 }, "step_up_required"],
    [404, { error: "not_found" }, "not_found"],
    [409, { error: "conflict", error_description: "c" }, "conflict"],
  ] as const)("%i %j => %s (every write and getUser), never uncertain", async (status, body, code) => {
    for (const [, fn, data] of [...WRITES(), ["getUser", fns.getUser, ID] as const]) {
      beFetch.mockResolvedValueOnce(json(status, body));
      const result = (await fn({ data })) as { ok: false; error: { code: string; uncertain?: true } };
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe(code);
      expect(result.error.uncertain).toBeUndefined();
    }
  });
});

describe("uncertain: writes only", () => {
  it.each([
    ["timeout", () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))],
    ["network", () => Promise.reject(new TypeError("fetch failed"))],
    ["5xx", () => Promise.resolve(json(502, {}))],
  ])("%s => unavailable + uncertain for every write, sent once", async (_, res) => {
    for (const [, fn, data] of WRITES()) {
      beFetch.mockReset();
      beFetch.mockImplementation(res);
      expect(await fn({ data })).toEqual({ ok: false, error: { code: "unavailable", message: expect.any(String), uncertain: true } });
      expect(beFetch).toHaveBeenCalledTimes(1);
    }
  });

  it("lock/unlock 2xx off schema or not JSON => uncertain", async () => {
    for (const res of [json(200, { id: ID }), new Response("x", { status: 200 })]) {
      for (const fn of [fns.lockUser, fns.unlockUser]) {
        beFetch.mockResolvedValueOnce(res.clone());
        expect(await fn({ data: ID })).toMatchObject({ ok: false, error: { code: "unavailable", uncertain: true } });
      }
    }
  });

  it("a 204-op answering 200 (not 204) => uncertain", async () => {
    for (const [name, fn, data] of WRITES()) {
      if (name.endsWith("lockUser")) continue;
      beFetch.mockResolvedValueOnce(json(200, {}));
      expect(await fn({ data })).toMatchObject({ ok: false, error: { code: "unavailable", uncertain: true } });
    }
  });

  it("GET 5xx => unavailable, NOT uncertain", async () => {
    for (const [fn, data] of [
      [fns.listUsers, { email: EMAIL }],
      [fns.getUser, ID],
      [fns.listUserFamilies, { userId: ID }],
      [fns.listUserConsents, { userId: ID }],
    ] as const) {
      beFetch.mockResolvedValueOnce(json(503, {}));
      expect(await fn({ data })).toEqual({ ok: false, error: { code: "unavailable", message: expect.any(String) } });
    }
  });
});

describe("the email filter is never logged", () => {
  it.each([
    ["timeout", () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))],
    ["network", () => Promise.reject(new TypeError("fetch failed"))],
    ["5xx", () => Promise.resolve(json(503, { email: EMAIL }))],
    ["4xx", () => Promise.resolve(json(418, { error: "teapot" }))],
    ["off schema", () => Promise.resolve(json(200, { items: [{ email: EMAIL }] }))],
  ])("%s: no log line (console.*) holds the email; the route template is logged", async (_, res) => {
    beFetch.mockImplementation(res);
    await fns.listUsers({ data: { email: EMAIL } }).catch(() => undefined);
    const text = logged.join("\n");
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain(encodeURIComponent(EMAIL));
  });

  it("the logged failure names /admin/users (template)", async () => {
    beFetch.mockRejectedValue(new TypeError("fetch failed"));
    await fns.listUsers({ data: { email: EMAIL } });
    expect(logged.join("\n")).toContain("GET /admin/users failed");
  });
});

describe("input validators (before the BE)", () => {
  const BAD_IDS = ["abc", "../x", "a".repeat(25), "a".repeat(23), "g".repeat(24), `${"a".repeat(23)}/`, "", 1, null];

  it.each(BAD_IDS)("user id %j refused by every user fn", async (id) => {
    for (const [fn, data] of [
      [fns.getUser, id],
      [fns.lockUser, id],
      [fns.unlockUser, id],
      [fns.revokeUserSessions, id],
      [fns.listUserFamilies, { userId: id }],
      [fns.listUserConsents, { userId: id }],
      [fns.revokeUserFamily, { userId: id, familyId: "fam-1" }],
      [fns.revokeUserConsent, { userId: id, consentId: CONSENT.id }],
    ] as const) {
      await expect(fn({ data })).rejects.toThrow();
    }
    expect(beFetch).not.toHaveBeenCalled();
  });

  it.each(["a/b", "a b", "", "x".repeat(129), "..", "a.b", "a%2Fb"])("familyId %j refused", async (familyId) => {
    await expect(fns.revokeUserFamily({ data: { userId: ID, familyId } })).rejects.toThrow();
    expect(beFetch).not.toHaveBeenCalled();
  });

  it.each(["xyz", "b".repeat(23), "b".repeat(25), "z".repeat(24), "../x"])("consentId %j refused", async (consentId) => {
    await expect(fns.revokeUserConsent({ data: { userId: ID, consentId } })).rejects.toThrow();
    expect(beFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown key", { role: "x" }],
    ["empty email", { email: "  " }],
    ["321-char email", { email: `${"a".repeat(309)}@example.com` }],
    ["bad status", { status: "locked" }],
    ["limit 101", { limit: 101 }],
    ["empty after", { after: "" }],
  ])("listUsers: %s refused", async (_, data) => {
    await expect(fns.listUsers({ data })).rejects.toThrow();
    expect(beFetch).not.toHaveBeenCalled();
  });

  it("uppercase hex ids and a 128-char family id are accepted", async () => {
    beFetch.mockResolvedValue(new Response(null, { status: 204 }));
    await fns.revokeUserFamily({ data: { userId: "A".repeat(24), familyId: "F-".repeat(64) } });
    expect(call().url).toBe(`http://idp.test/admin/users/${"A".repeat(24)}/families/${"F-".repeat(64)}/revoke`);
  });
});
