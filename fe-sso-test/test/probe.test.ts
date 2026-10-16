// @vitest-environment node
import { describe, it, expect, beforeAll, vi } from "vitest";
import { createLocalJWKSet } from "jose";
import {
  handleAudProbeCallback,
  takeProbeResult,
  saveProbeResult,
  PROBE_RESULT_KEY,
  PROBE_EXPECTED_STATUS,
  type ProbeResult,
} from "../src/oidc/probe";
import { makeKeys, signIdToken, type TestKeys } from "./helpers/jwt";
import { discovery, ISSUER, CLIENT_ID, REDIRECT_URI, memStore, tokenResponse } from "./helpers/env";
import type { TransientStore } from "../src/oidc/transient";

const DEMO_URL = "http://localhost:4000/demo/me";
const PROBE_RESOURCE = "http://localhost:4000/other/";
const STATE = "probe-state-xyz";
const NONCE = "probe-nonce-xyz";
const VERIFIER = "probe-verifier-xyz";
const PROBE_AT = "probe-at-secret-must-not-leak";

let keys: TestKeys;
beforeAll(async () => {
  keys = await makeKeys();
});

function jwks() {
  return createLocalJWKSet({ keys: [keys.publicJwk] });
}

/** A transient store seeded with a valid aud-probe transient. */
function probeStore(extra: Record<string, string> = {}): TransientStore {
  return memStore({
    "oidc:transient": JSON.stringify({
      state: STATE,
      nonce: NONCE,
      verifier: VERIFIER,
      createdAt: 1_000_000,
      purpose: "aud-probe",
    }),
    ...extra,
  });
}

function config() {
  return {
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    issuer: ISSUER,
    demoApiUrl: DEMO_URL,
    probeResource: PROBE_RESOURCE,
  };
}

async function probeTokenFetch(demoStatus: number) {
  const idToken = await signIdToken(keys, { nonce: NONCE, sub: "user-7" });
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === discovery.token_endpoint) {
      return tokenResponse({
        access_token: PROBE_AT,
        token_type: "Bearer",
        expires_in: 900,
        scope: "openid",
        id_token: idToken,
      });
    }
    if (url === DEMO_URL) {
      return new Response(JSON.stringify({ error: "invalid_token" }), {
        status: demoStatus,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;
}

describe("takeProbeResult — one-shot, status-only (no token)", () => {
  it("reads then deletes the stored result (returns null the second time)", () => {
    const store = memStore();
    saveProbeResult(store, { status: 401, expected: 401, aud: PROBE_RESOURCE });
    const first = takeProbeResult(store);
    expect(first).toEqual({ status: 401, expected: 401, aud: PROBE_RESOURCE });
    expect(takeProbeResult(store)).toBeNull();
    expect(store.getItem(PROBE_RESULT_KEY)).toBeNull();
  });

  it("returns null for a missing or malformed result (fail-closed)", () => {
    expect(takeProbeResult(memStore())).toBeNull();
    expect(takeProbeResult(memStore({ [PROBE_RESULT_KEY]: "not json" }))).toBeNull();
    expect(takeProbeResult(memStore({ [PROBE_RESULT_KEY]: "{}" }))).toBeNull();
  });
});

describe("handleAudProbeCallback — INV-8 observed from the RP, no token persisted", () => {
  it("stores ONLY {status, expected:401, aud} and never the token", async () => {
    const store = probeStore();
    const fetchImpl = await probeTokenFetch(401);
    const result = await handleAudProbeCallback(
      new URLSearchParams({ code: "abc", state: STATE, iss: ISSUER }),
      config(),
      { discovery, store, jwks: jwks(), fetchImpl, now: () => 1_000_000 },
    );
    expect(result).toEqual({ status: 401, expected: PROBE_EXPECTED_STATUS, aud: PROBE_RESOURCE });

    // The stored value is the status-only result — it must NOT contain the probe access token.
    const raw = store.getItem(PROBE_RESULT_KEY) ?? "";
    expect(raw).not.toContain(PROBE_AT);
    const stored = JSON.parse(raw) as ProbeResult;
    expect(stored.aud).toBe(PROBE_RESOURCE);
    expect(Object.keys(stored).sort()).toEqual(["aud", "expected", "status"]);
  });

  it("records a non-401 status verbatim (score is the caller's job)", async () => {
    const store = probeStore();
    const fetchImpl = await probeTokenFetch(200);
    const result = await handleAudProbeCallback(
      new URLSearchParams({ code: "abc", state: STATE, iss: ISSUER }),
      config(),
      { discovery, store, jwks: jwks(), fetchImpl, now: () => 1_000_000 },
    );
    expect(result.status).toBe(200);
    expect(result.expected).toBe(401);
  });

  it("records status 0 (not throw) when the demo call fails with a network/CORS error", async () => {
    const store = probeStore();
    const idToken = await signIdToken(keys, { nonce: NONCE, sub: "user-7" });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === discovery.token_endpoint) {
        return tokenResponse({
          access_token: PROBE_AT,
          token_type: "Bearer",
          expires_in: 900,
          scope: "openid",
          id_token: idToken,
        });
      }
      throw new TypeError("Failed to fetch"); // CORS/network on /demo/me
    }) as unknown as typeof fetch;
    const result = await handleAudProbeCallback(
      new URLSearchParams({ code: "abc", state: STATE, iss: ISSUER }),
      config(),
      { discovery, store, jwks: jwks(), fetchImpl, now: () => 1_000_000 },
    );
    expect(result.status).toBe(0);
  });

  it("consumes the transient up front (deleted on every branch)", async () => {
    const store = probeStore();
    const fetchImpl = await probeTokenFetch(401);
    await handleAudProbeCallback(
      new URLSearchParams({ code: "abc", state: STATE, iss: ISSUER }),
      config(),
      { discovery, store, jwks: jwks(), fetchImpl, now: () => 1_000_000 },
    );
    expect(store.getItem("oidc:transient")).toBeNull();
  });

  it("rejects a state mismatch (CSRF) before any exchange", async () => {
    const store = probeStore();
    const fetchImpl = await probeTokenFetch(401);
    await expect(
      handleAudProbeCallback(
        new URLSearchParams({ code: "abc", state: "WRONG", iss: ISSUER }),
        config(),
        { discovery, store, jwks: jwks(), fetchImpl, now: () => 1_000_000 },
      ),
    ).rejects.toThrow(/state mismatch/);
  });

  it("rejects an iss mismatch (mix-up) before any exchange", async () => {
    const store = probeStore();
    const fetchImpl = await probeTokenFetch(401);
    await expect(
      handleAudProbeCallback(
        new URLSearchParams({ code: "abc", state: STATE, iss: "http://evil" }),
        config(),
        { discovery, store, jwks: jwks(), fetchImpl, now: () => 1_000_000 },
      ),
    ).rejects.toThrow(/mix-up/);
  });

  it("refuses to run when the transient is not an aud-probe (fail-closed)", async () => {
    const store = memStore({
      "oidc:transient": JSON.stringify({
        state: STATE,
        nonce: NONCE,
        verifier: VERIFIER,
        createdAt: 1_000_000,
      }),
    });
    const fetchImpl = await probeTokenFetch(401);
    await expect(
      handleAudProbeCallback(
        new URLSearchParams({ code: "abc", state: STATE, iss: ISSUER }),
        config(),
        { discovery, store, jwks: jwks(), fetchImpl, now: () => 1_000_000 },
      ),
    ).rejects.toThrow(/No aud-probe in progress/);
  });
});
