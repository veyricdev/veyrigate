// @vitest-environment node
import { describe, it, expect, vi, beforeAll } from "vitest";
import { createLocalJWKSet } from "jose";
import { handleCallback } from "../src/oidc/callback";
import { createTokenStore } from "../src/oidc/tokenStore";
import { makeKeys, signIdToken, type TestKeys } from "./helpers/jwt";
import { discovery, ISSUER, CLIENT_ID, REDIRECT_URI, memStore, tokenResponse } from "./helpers/env";

const NONCE = "nonce-xyz";
const STATE = "state-xyz";
let keys: TestKeys;

beforeAll(async () => {
  keys = await makeKeys();
});

function transientSeed(now = 1_000_000) {
  return {
    "oidc:transient": JSON.stringify({
      state: STATE,
      nonce: NONCE,
      verifier: "verifier-123",
      createdAt: now,
    }),
  };
}

function config() {
  return { clientId: CLIENT_ID, redirectUri: REDIRECT_URI, issuer: ISSUER };
}

async function deps(fetchImpl: typeof fetch, store = memStore(transientSeed())) {
  return {
    discovery,
    store,
    tokens: createTokenStore(),
    jwks: createLocalJWKSet({ keys: [keys.publicJwk] }),
    fetchImpl,
    now: () => 1_000_000,
  };
}

function okParams(overrides: Record<string, string> = {}) {
  const p = new URLSearchParams({ code: "abc", state: STATE, iss: ISSUER });
  for (const [k, v] of Object.entries(overrides)) p.set(k, v);
  return p;
}

describe("handleCallback", () => {
  it("exchanges the code and stores an in-memory session on the happy path", async () => {
    const idToken = await signIdToken(keys, { nonce: NONCE });
    const fetchImpl = vi.fn().mockResolvedValue(
      tokenResponse({
        access_token: "at",
        token_type: "Bearer",
        expires_in: 900,
        scope: "openid",
        id_token: idToken,
        refresh_token: "rt1",
      }),
    );
    const d = await deps(fetchImpl as unknown as typeof fetch);
    const session = await handleCallback(okParams(), config(), d);
    expect(session.accessToken).toBe("at");
    expect(session.refreshToken).toBe("rt1");
    expect(d.tokens.get()?.claims.sub).toBe("user-123");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects an id_token whose nonce differs from the transient (replay, INV-7)", async () => {
    // Prove the callback actually validates the ID token's nonce against the transient: a token
    // whose nonce does NOT match must be refused and NO session stored. Replacing validateIdToken
    // with an unchecked decode makes this test (and the bad-signature one) fail.
    const idToken = await signIdToken(keys, { nonce: "attacker-nonce" });
    const fetchImpl = vi.fn().mockResolvedValue(
      tokenResponse({
        access_token: "at",
        token_type: "Bearer",
        expires_in: 900,
        scope: "openid",
        id_token: idToken,
      }),
    );
    const d = await deps(fetchImpl as unknown as typeof fetch);
    await expect(handleCallback(okParams(), config(), d)).rejects.toThrow(/nonce/);
    expect(d.tokens.get()).toBeNull();
  });

  it("rejects an id_token signed by an unknown key (forged signature, INV-6)", async () => {
    const forgedKeys = await makeKeys("attacker-key");
    const idToken = await signIdToken(forgedKeys, { nonce: NONCE });
    const fetchImpl = vi.fn().mockResolvedValue(
      tokenResponse({
        access_token: "at",
        token_type: "Bearer",
        expires_in: 900,
        scope: "openid",
        id_token: idToken,
      }),
    );
    const d = await deps(fetchImpl as unknown as typeof fetch);
    await expect(handleCallback(okParams(), config(), d)).rejects.toThrow();
    expect(d.tokens.get()).toBeNull();
  });

  it("rejects on state mismatch and never calls /token (CSRF)", async () => {
    const fetchImpl = vi.fn();
    const d = await deps(fetchImpl as unknown as typeof fetch);
    await expect(handleCallback(okParams({ state: "wrong" }), config(), d)).rejects.toThrow(
      /state mismatch/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(d.tokens.get()).toBeNull();
  });

  it("rejects when iss differs from the issuer and never calls /token (mix-up, F5)", async () => {
    const fetchImpl = vi.fn();
    const d = await deps(fetchImpl as unknown as typeof fetch);
    await expect(
      handleCallback(okParams({ iss: "http://evil.example" }), config(), d),
    ).rejects.toThrow(/mix-up/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(d.tokens.get()).toBeNull();
  });

  it("rejects when iss is absent (F5: iss mandatory)", async () => {
    const fetchImpl = vi.fn();
    const d = await deps(fetchImpl as unknown as typeof fetch);
    const p = new URLSearchParams({ code: "abc", state: STATE });
    await expect(handleCallback(p, config(), d)).rejects.toThrow(/iss missing/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(d.tokens.get()).toBeNull();
  });

  it("surfaces an IdP error response without echoing error_description (content spoofing)", async () => {
    const fetchImpl = vi.fn();
    const d = await deps(fetchImpl as unknown as typeof fetch);
    const p = new URLSearchParams({
      error: "access_denied",
      error_description: "Call 1-800-SCAM to restore access",
    });
    const err = await handleCallback(p, config(), d).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(err).toMatch(/access_denied/);
    expect(err).toMatch(/identity provider/i);
    // The attacker-controlled error_description must NOT be reflected.
    expect(err).not.toMatch(/SCAM/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(d.tokens.get()).toBeNull();
  });

  describe("clears the transient on every branch (OPEN-1)", () => {
    const KEY = "oidc:transient";

    it("clears it on the IdP-error branch", async () => {
      const store = memStore(transientSeed());
      const d = await deps(vi.fn() as unknown as typeof fetch, store);
      await expect(
        handleCallback(new URLSearchParams({ error: "access_denied" }), config(), d),
      ).rejects.toThrow();
      expect(store.getItem(KEY)).toBeNull();
    });

    it("clears it when code/state are missing", async () => {
      const store = memStore(transientSeed());
      const d = await deps(vi.fn() as unknown as typeof fetch, store);
      await expect(
        handleCallback(new URLSearchParams({ state: STATE }), config(), d),
      ).rejects.toThrow(/missing code/);
      expect(store.getItem(KEY)).toBeNull();
    });

    it("clears it on state mismatch", async () => {
      const store = memStore(transientSeed());
      const d = await deps(vi.fn() as unknown as typeof fetch, store);
      await expect(
        handleCallback(okParams({ state: "wrong" }), config(), d),
      ).rejects.toThrow(/state mismatch/);
      expect(store.getItem(KEY)).toBeNull();
    });

    it("clears it on iss mismatch", async () => {
      const store = memStore(transientSeed());
      const d = await deps(vi.fn() as unknown as typeof fetch, store);
      await expect(
        handleCallback(okParams({ iss: "http://evil.example" }), config(), d),
      ).rejects.toThrow(/mix-up/);
      expect(store.getItem(KEY)).toBeNull();
    });
  });

  it("deletes the transient before exchange and exchanges a given code only once (F2/StrictMode)", async () => {
    const idToken = await signIdToken(keys, { nonce: NONCE });
    const fetchImpl = vi.fn().mockResolvedValue(
      tokenResponse({
        access_token: "at",
        token_type: "Bearer",
        expires_in: 900,
        scope: "openid",
        id_token: idToken,
      }),
    );
    const store = memStore(transientSeed());
    const d = await deps(fetchImpl as unknown as typeof fetch, store);
    const [a, b] = await Promise.all([
      handleCallback(okParams(), config(), d),
      handleCallback(okParams(), config(), d),
    ]);
    expect(a).toEqual(b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.getItem("oidc:transient")).toBeNull();
  });

  it("rejects a stale transient (F6)", async () => {
    const fetchImpl = vi.fn();
    const store = memStore(transientSeed(0)); // created at t=0
    const d = await deps(fetchImpl as unknown as typeof fetch, store);
    await expect(handleCallback(okParams(), config(), d)).rejects.toThrow(/expired/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
