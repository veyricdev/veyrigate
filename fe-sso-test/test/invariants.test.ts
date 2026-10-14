// @vitest-environment node
import { describe, it, expect, beforeAll, vi, afterEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLocalJWKSet } from "jose";
import { handleCallback } from "../src/oidc/callback";
import { refreshSession } from "../src/oidc/refresh";
import { createTokenStore, type Session } from "../src/oidc/tokenStore";
import { makeKeys, signIdToken, type TestKeys } from "./helpers/jwt";
import { discovery, ISSUER, CLIENT_ID, REDIRECT_URI, memStore, tokenResponse } from "./helpers/env";

/** Recursively collect every .ts/.tsx under a dir. */
function collect(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collect(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

const SRC = join(__dirname, "..", "src");
const files = collect(SRC);

describe("token-exposure invariants (F7, OPEN-1)", () => {
  it("no localStorage/sessionStorage.setItem persists a token", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      // Flag any Web Storage write that mentions a token.
      const re = /(local|session)Storage\.setItem\([^)]*(access_token|refresh_token|id_token|accessToken|refreshToken|idToken)/i;
      if (re.test(text)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it("src never console.* logs a token/code/verifier", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      const re = /console\.[a-z]+\([^)]*(access_token|refresh_token|id_token|code_verifier|verifier|accessToken|refreshToken)/i;
      if (re.test(text)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Runtime proof (complements the static grep above): run a REAL login flow with Web Storage
 * globals installed and assert that no token string ever reaches `localStorage`/`sessionStorage`,
 * and that a page reload (a fresh in-memory store) leaves the user anonymous (OPEN-1 / F7).
 */
describe("tokens never reach Web Storage at runtime (OPEN-1, F7)", () => {
  let keys: TestKeys;
  const ACCESS = "at-secret-xyz";
  const REFRESH = "rt-secret-xyz";
  const NONCE = "nonce-xyz";
  const STATE = "state-xyz";

  beforeAll(async () => {
    keys = await makeKeys();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A real-ish Web Storage that records every value written to it. */
  function spyStorage(writes: string[]): Storage {
    const m = new Map<string, string>();
    return {
      get length() {
        return m.size;
      },
      clear: () => m.clear(),
      getItem: (k: string) => m.get(k) ?? null,
      key: (i: number) => [...m.keys()][i] ?? null,
      removeItem: (k: string) => void m.delete(k),
      setItem: (k: string, v: string) => {
        writes.push(v);
        m.set(k, v);
      },
    } as Storage;
  }

  function transientSeed() {
    return {
      "oidc:transient": JSON.stringify({
        state: STATE,
        nonce: NONCE,
        verifier: "verifier-123",
        createdAt: 1_000_000,
      }),
    };
  }

  it("a full callback + refresh keeps access/refresh/id tokens out of local/sessionStorage", async () => {
    const writes: string[] = [];
    vi.stubGlobal("localStorage", spyStorage(writes));
    vi.stubGlobal("sessionStorage", spyStorage(writes));

    const idToken = await signIdToken(keys, { nonce: NONCE, sub: "user-1" });
    const refreshedId = await signIdToken(keys, { omitNonce: true, sub: "user-1" });

    const tokens = createTokenStore();
    const jwks = createLocalJWKSet({ keys: [keys.publicJwk] });

    // Callback exchange (transient lives in the injected sessionStorage-shaped memStore here, but
    // the real global storages are watched to catch any accidental token write anywhere in src).
    const transientStore = memStore(transientSeed());
    const exchangeFetch = vi.fn().mockResolvedValue(
      tokenResponse({
        access_token: ACCESS,
        token_type: "Bearer",
        expires_in: 900,
        scope: "openid offline_access",
        id_token: idToken,
        refresh_token: REFRESH,
      }),
    );
    const session: Session = await handleCallback(
      new URLSearchParams({ code: "abc", state: STATE, iss: ISSUER }),
      { clientId: CLIENT_ID, redirectUri: REDIRECT_URI, issuer: ISSUER },
      {
        discovery,
        store: transientStore,
        tokens,
        jwks,
        fetchImpl: exchangeFetch as unknown as typeof fetch,
        now: () => 1_000_000,
      },
    );
    expect(session.accessToken).toBe(ACCESS);

    // Rotate once.
    const refreshFetch = vi.fn().mockResolvedValue(
      tokenResponse({
        access_token: "at-new",
        token_type: "Bearer",
        expires_in: 900,
        scope: "openid offline_access",
        id_token: refreshedId,
        refresh_token: "rt-new",
      }),
    );
    await refreshSession(
      { clientId: CLIENT_ID, issuer: ISSUER },
      {
        discovery,
        tokens,
        jwks,
        fetchImpl: refreshFetch as unknown as typeof fetch,
        now: () => 1_000_000,
      },
    );

    // No token value (old or rotated) was ever written to any Web Storage.
    const tokenValues = [ACCESS, REFRESH, idToken, refreshedId, "at-new", "rt-new"];
    for (const v of tokenValues) {
      expect(writes.some((w) => w.includes(v))).toBe(false);
    }
  });

  it("reload (a fresh in-memory store) drops the session -> anonymous", () => {
    const tokens = createTokenStore();
    tokens.set({
      accessToken: ACCESS,
      idToken: "id",
      refreshToken: REFRESH,
      claims: { iss: ISSUER, sub: "user-1", aud: CLIENT_ID, exp: 0, iat: 0 },
      accessTokenExpiresAt: 0,
    });
    expect(tokens.get()).not.toBeNull();
    // A reload re-evaluates the module and creates a brand-new store with nothing recovered from
    // any persistent storage: the user is anonymous again.
    const afterReload = createTokenStore();
    expect(afterReload.get()).toBeNull();
  });
});
