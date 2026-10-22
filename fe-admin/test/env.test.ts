// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseServerEnv } from "@/server/env";

const valid = {
  OIDC_ISSUER: "http://localhost:4000",
  OIDC_CLIENT_ID: "fe-admin",
  OIDC_CLIENT_SECRET: "x".repeat(32),
  SESSION_SECRET: "y".repeat(32),
  ADMIN_API_BASE_URL: "http://localhost:4000",
  ADMIN_API_RESOURCE: "http://localhost:4000/admin/",
  APP_URL: "http://localhost:3000",
};

function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected parseServerEnv to throw");
}

describe("parseServerEnv", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns the typed env when every variable is valid", () => {
    const env = parseServerEnv(valid);
    expect(env.OIDC_CLIENT_ID).toBe("fe-admin");
    expect(env.APP_URL).toBe("http://localhost:3000");
  });

  it("does not mutate the source object", () => {
    const source = { ...valid, OIDC_ISSUER: "" };
    vi.spyOn(console, "error").mockImplementation(() => {});
    captureError(() => parseServerEnv(source));
    expect(source).toHaveProperty("OIDC_ISSUER", "");
  });

  it("throws naming OIDC_CLIENT_SECRET when it is missing", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { OIDC_CLIENT_SECRET: _omit, ...rest } = valid;
    const err = captureError(() => parseServerEnv(rest));
    expect(err.message).toContain("OIDC_CLIENT_SECRET");
  });

  it("treats an empty string as missing", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const err = captureError(() => parseServerEnv({ ...valid, OIDC_CLIENT_SECRET: "" }));
    expect(err.message).toContain("OIDC_CLIENT_SECRET: is required");
  });

  it("never echoes a rejected secret value in the error or the log", () => {
    const logged: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => logged.push(...args));
    const canary = "canary-" + "s".repeat(24); // 31 chars: below the 32 minimum
    expect(canary).toHaveLength(31);
    const err = captureError(() => parseServerEnv({ ...valid, SESSION_SECRET: canary }));
    expect(err.message).toContain("SESSION_SECRET");
    expect(err.message).not.toContain(canary);
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged.map(String))).not.toContain("canary-");
  });

  it("requires https public URLs in production", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const prod = {
      ...valid,
      NODE_ENV: "production",
      ADMIN_API_BASE_URL: "https://api.example.com",
      APP_URL: "https://admin.example.com",
    };
    const err = captureError(() =>
      parseServerEnv({ ...prod, OIDC_ISSUER: "http://idp.example.com" }),
    );
    expect(err.message).toContain("OIDC_ISSUER");
    expect(parseServerEnv({ ...prod, OIDC_ISSUER: "https://idp.example.com" }).OIDC_ISSUER).toBe(
      "https://idp.example.com",
    );
  });

  it("rejects an APP_URL with a path or trailing slash", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const APP_URL of ["http://localhost:3000/", "http://localhost:3000/admin"]) {
      expect(captureError(() => parseServerEnv({ ...valid, APP_URL })).message).toContain("APP_URL");
    }
  });
});
