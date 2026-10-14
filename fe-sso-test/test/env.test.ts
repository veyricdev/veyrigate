import { describe, it, expect } from "vitest";
import { parseEnv } from "../src/env";

const validEnv = {
  VITE_OIDC_ISSUER: "http://localhost:4000",
  VITE_OIDC_CLIENT_ID: "fe-sso-test",
  VITE_OIDC_REDIRECT_URI: "http://localhost:5173/callback",
  VITE_OIDC_POST_LOGOUT_URI: "http://localhost:5173/",
  VITE_OIDC_SCOPE: "openid profile email offline_access",
  VITE_OIDC_RESOURCE: "http://localhost:4000/demo/",
  VITE_DEMO_API_URL: "http://localhost:4000/demo/me",
};

describe("parseEnv", () => {
  it("returns a parsed object when all vars are present and valid", () => {
    const env = parseEnv(validEnv);
    expect(env.VITE_OIDC_ISSUER).toBe("http://localhost:4000");
    expect(env.VITE_OIDC_CLIENT_ID).toBe("fe-sso-test");
    expect(env.VITE_OIDC_RESOURCE).toBe("http://localhost:4000/demo/");
  });

  it("throws naming the missing var and hints at .env.example", () => {
    const { VITE_OIDC_ISSUER: _omitted, ...missing } = validEnv;
    expect(() => parseEnv(missing)).toThrowError(/VITE_OIDC_ISSUER/);
    expect(() => parseEnv(missing)).toThrowError(/cp \.env\.example \.env/);
  });

  it("rejects a non-URL issuer", () => {
    expect(() => parseEnv({ ...validEnv, VITE_OIDC_ISSUER: "not-a-url" })).toThrowError(
      /VITE_OIDC_ISSUER/,
    );
  });

  it("rejects a resource with a fragment (RFC 8707)", () => {
    expect(() =>
      parseEnv({ ...validEnv, VITE_OIDC_RESOURCE: "http://localhost:4000/demo/#x" }),
    ).toThrowError(/VITE_OIDC_RESOURCE/);
  });

  it("rejects a scope missing openid", () => {
    expect(() => parseEnv({ ...validEnv, VITE_OIDC_SCOPE: "profile email" })).toThrowError(
      /VITE_OIDC_SCOPE/,
    );
  });
});
