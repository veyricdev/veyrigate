// @vitest-environment node
import { describe, it, expect } from "vitest";
import { createTokenStore, type Session } from "../src/oidc/tokenStore";

function s(): Session {
  return {
    accessToken: "at",
    idToken: "id",
    refreshToken: "rt",
    claims: { iss: "i", sub: "u", aud: "a", exp: 0, iat: 0 },
    accessTokenExpiresAt: 0,
  };
}

describe("createTokenStore (in-memory only)", () => {
  it("holds a session and clears it", () => {
    const store = createTokenStore();
    expect(store.get()).toBeNull();
    store.set(s());
    expect(store.get()?.accessToken).toBe("at");
    store.clear();
    expect(store.get()).toBeNull();
  });

  it("two stores are isolated (no shared/global token state)", () => {
    const a = createTokenStore();
    const b = createTokenStore();
    a.set(s());
    expect(b.get()).toBeNull();
  });
});
