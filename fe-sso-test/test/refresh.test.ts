// @vitest-environment node
import { describe, it, expect, vi, beforeAll } from "vitest";
import { createLocalJWKSet } from "jose";
import { refreshSession } from "../src/oidc/refresh";
import { createTokenStore, type Session } from "../src/oidc/tokenStore";
import { makeKeys, signIdToken, type TestKeys } from "./helpers/jwt";
import { discovery, ISSUER, CLIENT_ID, tokenResponse } from "./helpers/env";

let keys: TestKeys;
beforeAll(async () => {
  keys = await makeKeys();
});

function seededStore(refreshToken = "rt-old") {
  const store = createTokenStore();
  const session: Session = {
    accessToken: "at-old",
    idToken: "id-old",
    refreshToken,
    claims: { iss: ISSUER, sub: "user-123", aud: CLIENT_ID, exp: 0, iat: 0 },
    accessTokenExpiresAt: 0,
  };
  store.set(session);
  return store;
}

function depsFor(store: ReturnType<typeof seededStore>, fetchImpl: typeof fetch) {
  return {
    discovery,
    tokens: store,
    jwks: createLocalJWKSet({ keys: [keys.publicJwk] }),
    fetchImpl,
    now: () => 2_000_000,
  };
}

describe("refreshSession", () => {
  it("rotates: stores the new refresh_token and drops the old one", async () => {
    const idToken = await signIdToken(keys, { omitNonce: true, sub: "user-123" });
    const fetchImpl = vi.fn().mockResolvedValue(
      tokenResponse({
        access_token: "at-new",
        token_type: "Bearer",
        expires_in: 900,
        scope: "openid offline_access",
        id_token: idToken,
        refresh_token: "rt-new",
      }),
    );
    const store = seededStore("rt-old");
    const d = depsFor(store, fetchImpl as unknown as typeof fetch);
    const session = await refreshSession({ clientId: CLIENT_ID, issuer: ISSUER }, d);
    expect(session.accessToken).toBe("at-new");
    expect(session.refreshToken).toBe("rt-new");
    expect(store.get()?.refreshToken).toBe("rt-new");
  });

  it("is single-flight: concurrent calls share one /token request (F3)", async () => {
    const idToken = await signIdToken(keys, { omitNonce: true, sub: "user-123" });
    const fetchImpl = vi.fn().mockResolvedValue(
      tokenResponse({
        access_token: "at-new",
        token_type: "Bearer",
        expires_in: 900,
        scope: "openid offline_access",
        id_token: idToken,
        refresh_token: "rt-new",
      }),
    );
    const store = seededStore("rt-old");
    const d = depsFor(store, fetchImpl as unknown as typeof fetch);
    const [a, b] = await Promise.all([
      refreshSession({ clientId: CLIENT_ID, issuer: ISSUER }, d),
      refreshSession({ clientId: CLIENT_ID, issuer: ISSUER }, d),
    ]);
    expect(a).toBe(b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("clears the session fail-closed on invalid_grant, no retry", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(tokenResponse({ error: "invalid_grant" }, 400));
    const store = seededStore("rt-old");
    const d = depsFor(store, fetchImpl as unknown as typeof fetch);
    await expect(
      refreshSession({ clientId: CLIENT_ID, issuer: ISSUER }, d),
    ).rejects.toThrow(/invalid_grant/);
    expect(store.get()).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not resurrect a session logged out while the refresh was in flight", async () => {
    const idToken = await signIdToken(keys, { omitNonce: true, sub: "user-123" });
    const store = seededStore("rt-old");
    // Clear the store (simulating a concurrent logout) as soon as /token is awaited, before the
    // refreshed session would be committed.
    const fetchImpl = vi.fn().mockImplementation(async () => {
      store.clear();
      return tokenResponse({
        access_token: "at-new",
        token_type: "Bearer",
        expires_in: 900,
        scope: "openid offline_access",
        id_token: idToken,
        refresh_token: "rt-new",
      });
    });
    const d = depsFor(store, fetchImpl as unknown as typeof fetch);
    await refreshSession({ clientId: CLIENT_ID, issuer: ISSUER }, d);
    // The refreshed tokens must NOT be written back over the logged-out (null) session.
    expect(store.get()).toBeNull();
  });

  it("throws when there is no refresh_token", async () => {
    const store = createTokenStore();
    store.set({
      accessToken: "at",
      idToken: "id",
      claims: { iss: ISSUER, sub: "user-123", aud: CLIENT_ID, exp: 0, iat: 0 },
      accessTokenExpiresAt: 0,
    });
    const fetchImpl = vi.fn();
    const d = depsFor(store as ReturnType<typeof seededStore>, fetchImpl as unknown as typeof fetch);
    await expect(
      refreshSession({ clientId: CLIENT_ID, issuer: ISSUER }, d),
    ).rejects.toThrow(/No refresh_token/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
