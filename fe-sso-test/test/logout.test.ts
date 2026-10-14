// @vitest-environment node
import { describe, it, expect } from "vitest";
import { buildLogoutUrl, consumeLogoutState, logout } from "../src/oidc/logout";
import { createTokenStore, type Session } from "../src/oidc/tokenStore";
import { discovery, ISSUER, CLIENT_ID, memStore } from "./helpers/env";

const POST_LOGOUT = "http://localhost:5173/";

function session(): Session {
  return {
    accessToken: "at-secret",
    idToken: "id-token-hint",
    refreshToken: "rt-secret",
    claims: { iss: ISSUER, sub: "user-123", aud: CLIENT_ID, exp: 0, iat: 0 },
    accessTokenExpiresAt: 0,
  };
}

describe("buildLogoutUrl", () => {
  it("builds end_session URL with id_token_hint + post_logout_redirect_uri only", () => {
    const url = buildLogoutUrl(discovery, { postLogoutRedirectUri: POST_LOGOUT }, "id-token-hint")!;
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(`${ISSUER}/logout`);
    expect(u.searchParams.get("id_token_hint")).toBe("id-token-hint");
    expect(u.searchParams.get("post_logout_redirect_uri")).toBe(POST_LOGOUT);
    // Exposure budget: no access/refresh token in the URL.
    expect(url).not.toContain("at-secret");
    expect(url).not.toContain("rt-secret");
  });

  it("returns null when there is no id_token_hint", () => {
    expect(buildLogoutUrl(discovery, { postLogoutRedirectUri: POST_LOGOUT }, null)).toBeNull();
  });
});

describe("logout", () => {
  it("clears the in-memory session and returns the logout URL", () => {
    const store = createTokenStore();
    store.set(session());
    const url = logout(discovery, { postLogoutRedirectUri: POST_LOGOUT }, store)!;
    expect(url).toContain("id_token_hint=id-token-hint");
    expect(store.get()).toBeNull();
  });

  it("sends a fresh state, persists it, and verifies it on return (round-trip)", () => {
    const tokens = createTokenStore();
    tokens.set(session());
    const transient = memStore();
    const url = logout(discovery, { postLogoutRedirectUri: POST_LOGOUT }, tokens, transient)!;
    const sent = new URL(url).searchParams.get("state");
    expect(sent).toBeTruthy();
    // The correct state round-trips; a tampered one is rejected fail-closed.
    expect(consumeLogoutState(memStoreWith(sent!), sent)).toBe(true);
    expect(consumeLogoutState(memStoreWith(sent!), "tampered")).toBe(false);
  });

  it("consumes the pending state exactly once", () => {
    const transient = memStoreWith("s1");
    expect(consumeLogoutState(transient, "s1")).toBe(true);
    // Second call: state already consumed → fail-closed.
    expect(consumeLogoutState(transient, "s1")).toBe(false);
  });

  it("returns false when no logout state is pending", () => {
    expect(consumeLogoutState(memStore(), "anything")).toBe(false);
  });
});

function memStoreWith(state: string) {
  return memStore({ "oidc:logout_state": state });
}
