// @vitest-environment node
// Tester (run 41): risk matrix for the server env schema — every variable missing/malformed on its
// own, secret length boundary, APP_URL origin shape, https in production, no value echo.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseServerEnv } from "@/server/env";

const valid: Record<string, string> = {
  OIDC_ISSUER: "http://localhost:4000",
  OIDC_CLIENT_ID: "fe-admin",
  OIDC_CLIENT_SECRET: "x".repeat(32),
  SESSION_SECRET: "y".repeat(32),
  ADMIN_API_BASE_URL: "http://localhost:4000",
  ADMIN_API_RESOURCE: "http://localhost:4000/admin/",
  APP_URL: "http://localhost:3000",
};
const NAMES = Object.keys(valid);
const URL_NAMES = ["OIDC_ISSUER", "ADMIN_API_BASE_URL", "ADMIN_API_RESOURCE", "APP_URL"];
const SECRET_NAMES = ["OIDC_CLIENT_SECRET", "SESSION_SECRET"];
const PUBLIC_URL_NAMES = ["OIDC_ISSUER", "ADMIN_API_BASE_URL", "APP_URL"];
const prod = {
  ...valid,
  NODE_ENV: "production",
  OIDC_ISSUER: "https://idp.example.com",
  ADMIN_API_BASE_URL: "https://api.example.com",
  ADMIN_API_RESOURCE: "https://api.example.com/admin/",
  APP_URL: "https://admin.example.com",
};

let logged: string[];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...a) => void logged.push(a.map(String).join(" ")));
});
afterEach(() => vi.restoreAllMocks());

function errorOf(source: Record<string, string | undefined>): Error {
  try {
    parseServerEnv(source);
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected parseServerEnv to throw");
}

describe("each variable on its own", () => {
  it.each(NAMES)("missing %s => throws naming it", (name) => {
    const { [name]: _omit, ...rest } = valid;
    expect(errorOf(rest).message).toMatch(new RegExp(`- ${name}: `));
  });

  it.each(NAMES)("empty %s => same error as missing (emptyStringAsUndefined)", (name) => {
    const { [name]: _omit, ...rest } = valid;
    const empty = errorOf({ ...valid, [name]: "" }).message;
    expect(empty).toMatch(new RegExp(`- ${name}: `));
    expect(empty).toBe(errorOf(rest).message);
  });

  it.each(URL_NAMES)("malformed %s => throws naming it, never echoing the value", (name) => {
    const bad = "canary-url-9c1e not a url";
    const err = errorOf({ ...valid, [name]: bad });
    expect(err.message).toContain(`${name}: must be a valid URL`);
    expect(err.message).not.toContain("canary-url");
    expect(logged.join("\n")).not.toContain("canary-url");
  });

  it("lists every missing variable at once (operator fixes all in one go)", () => {
    const msg = errorOf({}).message;
    for (const name of NAMES) expect(msg).toContain(`${name}:`);
  });
});

describe("secrets", () => {
  it.each(SECRET_NAMES)("%s: 31 chars rejected, 32 accepted (boundary)", (name) => {
    const short = "canary-" + "k".repeat(24);
    expect(short).toHaveLength(31);
    const err = errorOf({ ...valid, [name]: short });
    expect(err.message).toContain(`${name}: must be at least 32 characters`);
    expect(err.message + logged.join("\n")).not.toContain("canary-");
    expect(() => parseServerEnv({ ...valid, [name]: "k".repeat(32) })).not.toThrow();
  });

  it("does not echo other (valid) secrets when a different variable fails", () => {
    const err = errorOf({ ...valid, OIDC_CLIENT_SECRET: "c".repeat(40), SESSION_SECRET: "s".repeat(40), APP_URL: "nope" });
    expect(err.message + logged.join("\n")).not.toContain("c".repeat(40));
    expect(err.message + logged.join("\n")).not.toContain("s".repeat(40));
  });
});

describe("APP_URL is a bare origin", () => {
  it.each([
    "http://localhost:3000/",
    "http://localhost:3000/admin",
    "http://localhost:3000?next=/x",
    "http://localhost:3000#frag",
    "http://user:pw@localhost:3000",
    "HTTP://LOCALHOST:3000",
  ])("rejects %s", (APP_URL) => {
    expect(errorOf({ ...valid, APP_URL }).message).toContain("APP_URL");
    expect(logged.join("\n")).not.toContain("user:pw");
  });

  it.each(["http://localhost:3000", "https://admin.example.com", "https://admin.example.com:8443"])(
    "accepts %s",
    (APP_URL) => {
      expect(parseServerEnv({ ...valid, APP_URL }).APP_URL).toBe(APP_URL);
    },
  );
});

describe("production requires https", () => {
  it("accepts an all-https production env", () => {
    expect(parseServerEnv(prod).APP_URL).toBe("https://admin.example.com");
  });

  it.each(PUBLIC_URL_NAMES)("%s=http:// in production => throws naming it", (name) => {
    const err = errorOf({ ...prod, [name]: "http://plain.example.com" });
    expect(err.message).toContain(`${name}: must be a valid https URL`);
  });

  it.each(PUBLIC_URL_NAMES)("%s with a non-http scheme in production => throws", (name) => {
    expect(errorOf({ ...prod, [name]: "javascript:alert(1)" }).message).toContain(name);
  });

  it("http public URLs stay allowed outside production (local dev)", () => {
    expect(() => parseServerEnv({ ...valid, NODE_ENV: "development" })).not.toThrow();
    expect(() => parseServerEnv({ ...valid, NODE_ENV: "test" })).not.toThrow();
  });
});

describe("check:bundle name list stays in sync with the schema", () => {
  it("the regex check-bundle.mjs uses parses exactly the schema keys", () => {
    const src = readFileSync(new URL("../src/server/env.ts", import.meta.url), "utf8");
    const parsed = [...src.matchAll(/^\s{4}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]);
    const keys = Object.keys(parseServerEnv(valid)).filter((k) => /^[A-Z]/.test(k));
    expect(parsed.sort()).toEqual(NAMES.slice().sort());
    expect(keys.sort()).toEqual(NAMES.slice().sort());
  });
});
