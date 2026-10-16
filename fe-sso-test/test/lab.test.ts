// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { beginLogin } from "../src/oidc/authorize";
import { handleCallback } from "../src/oidc/callback";
import { refreshSession } from "../src/oidc/refresh";
import { postToken, TokenEndpointError } from "../src/oidc/token-exchange";
import { createTokenStore, type Session } from "../src/oidc/tokenStore";
import { readTransient, type TransientStore } from "../src/oidc/transient";
import {
  LAB_SCENARIOS,
  LAB_RESULT_KEY,
  TAMPERED_STATE,
  buildScenarioUrl,
  checkStateTamper,
  findLabScenario,
  recordLabCallback,
  runRefreshReplay,
  takeLabResult,
  takeStateTamperExpectation,
  tamperState,
  type LabScenario,
} from "../src/oidc/lab";
import { CLIENT_ID, ISSUER, REDIRECT_URI, discovery, memStore, tokenResponse } from "./helpers/env";

const CONFIG = {
  clientId: CLIENT_ID,
  redirectUri: REDIRECT_URI,
  scope: "openid offline_access",
  resource: `${ISSUER}/demo/`,
};

function scenario(id: string): LabScenario {
  const s = findLabScenario(id);
  if (!s) throw new Error(`no scenario ${id}`);
  return s;
}

/** Start a lab scenario the way the app does: `beginLogin` (purpose lab) then mutate the URL. */
async function startScenario(id: string, store: TransientStore) {
  const { url, transient } = await beginLogin(
    discovery,
    { ...CONFIG, purpose: "lab", labScenario: id },
    store,
  );
  return { genuine: new URL(url), mutated: new URL(buildScenarioUrl(url, scenario(id), ISSUER)), transient };
}

/** Params that differ between two URLs (added, removed or changed), sorted. */
function changedParams(a: URL, b: URL): string[] {
  const keys = new Set([...a.searchParams.keys(), ...b.searchParams.keys()]);
  return [...keys].filter((k) => a.searchParams.get(k) !== b.searchParams.get(k)).sort();
}

describe("lab /authorize scenarios — URL built from beginLogin, one parameter altered (F1)", () => {
  it.each([
    ["redirect-uri-mismatch", ["redirect_uri"]],
    ["pkce-plain", ["code_challenge_method"]],
    ["no-code-challenge", ["code_challenge"]],
    ["resource-unknown", ["resource"]],
    ["resource-relative", ["resource"]],
    ["no-nonce", ["nonce"]],
    ["prompt-none-max-age-0", ["max_age", "prompt"]],
    ["prompt-none-no-session", ["prompt"]],
  ])("%s changes only %j", async (id, keys) => {
    const { genuine, mutated } = await startScenario(id, memStore());
    expect(changedParams(genuine, mutated)).toEqual(keys);
    expect(mutated.origin + mutated.pathname).toBe(discovery.authorization_endpoint);
  });

  it("produces the exact altered values", async () => {
    const p = async (id: string) => (await startScenario(id, memStore())).mutated.searchParams;
    expect((await p("redirect-uri-mismatch")).get("redirect_uri")).toBe("http://localhost:5173/callback-x");
    expect((await p("pkce-plain")).get("code_challenge_method")).toBe("plain");
    expect((await p("no-code-challenge")).has("code_challenge")).toBe(false);
    expect((await p("resource-unknown")).get("resource")).toBe(`${ISSUER}/unknown/`);
    expect((await p("resource-relative")).get("resource")).toBe("demo");
    expect((await p("no-nonce")).has("nonce")).toBe(false);
    const pn = await p("prompt-none-max-age-0");
    expect([pn.get("prompt"), pn.get("max_age")]).toEqual(["none", "0"]);
  });

  it("tags the transient purpose:lab + the scenario id (state/verifier kept for the callback)", async () => {
    const store = memStore();
    const { transient } = await startScenario("pkce-plain", store);
    expect(readTransient(store)).toMatchObject({ purpose: "lab", labScenario: "pkce-plain", state: transient.state });
  });

  it("expectations follow the IdP's actual behaviour (nonce is NOT an IdP error)", () => {
    expect(scenario("no-nonce").expect).toEqual({ kind: "code" });
    expect(scenario("redirect-uri-mismatch").expect).toEqual({ kind: "no-redirect" });
    expect(LAB_SCENARIOS).toHaveLength(8);
  });
});

describe("recordLabCallback — purpose:lab callback is recorded once and never exchanged (F2)", () => {
  async function callback(id: string, build: (state: string) => Record<string, string>) {
    const store = memStore();
    const { transient } = await startScenario(id, store);
    const result = recordLabCallback(new URLSearchParams(build(transient.state)), ISSUER, store);
    return { store, result };
  }

  it("expected error + matching state + iss ⇒ PASS; transient consumed; no state/code stored", async () => {
    const { store, result } = await callback("pkce-plain", (state) => ({
      error: "invalid_request",
      error_description: "<img src=x onerror=alert(1)>",
      state,
      iss: ISSUER,
    }));
    expect(result).toEqual({
      scenario: "pkce-plain",
      outcome: "error",
      error: "invalid_request",
      issOk: true,
      stateOk: true,
      pass: true,
    });
    expect(readTransient(store)).toBeNull();
    const stored = store.getItem(LAB_RESULT_KEY) ?? "";
    expect(stored).not.toContain("onerror");
    expect(stored).not.toContain(ISSUER);
  });

  it("invalid_target is recorded verbatim (whitelisted) for the resource scenarios", async () => {
    const { result } = await callback("resource-relative", (state) => ({ error: "invalid_target", state, iss: ISSUER }));
    expect(result?.pass).toBe(true);
    expect(result?.error).toBe("invalid_target");
  });

  it("no-nonce: a returned code is PASS and the code is never stored", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { store, result } = await callback("no-nonce", (state) => ({ code: "secret-code-123", state, iss: ISSUER }));
    vi.unstubAllGlobals();
    expect(result).toMatchObject({ outcome: "code", pass: true });
    expect(store.getItem(LAB_RESULT_KEY)).not.toContain("secret-code-123");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("state mismatch ⇒ rejected, never PASS (even with the expected error)", async () => {
    const { result } = await callback("pkce-plain", () => ({ error: "invalid_request", state: "forged", iss: ISSUER }));
    expect(result).toMatchObject({ outcome: "rejected", stateOk: false, pass: false });
    expect(result).not.toHaveProperty("error");
  });

  it("missing or wrong iss ⇒ FAIL", async () => {
    const a = await callback("pkce-plain", (state) => ({ error: "invalid_request", state }));
    const b = await callback("pkce-plain", (state) => ({ error: "invalid_request", state, iss: "https://evil.example" }));
    expect(a.result).toMatchObject({ issOk: false, pass: false });
    expect(b.result).toMatchObject({ issOk: false, pass: false });
  });

  it("a different error than expected ⇒ FAIL; an unknown code is collapsed", async () => {
    const { result } = await callback("pkce-plain", (state) => ({ error: "<script>", state, iss: ISSUER }));
    expect(result).toMatchObject({ error: "unknown_error", pass: false });
  });

  it("a code where an error was expected ⇒ FAIL", async () => {
    const { result } = await callback("prompt-none-max-age-0", (state) => ({ code: "c", state, iss: ISSUER }));
    expect(result).toMatchObject({ outcome: "code", pass: false });
  });

  it("not a lab transient / unknown scenario ⇒ nothing recorded (transient still consumed)", async () => {
    const store = memStore();
    await beginLogin(discovery, CONFIG, store);
    expect(recordLabCallback(new URLSearchParams({ code: "c" }), ISSUER, store)).toBeNull();
    expect(readTransient(store)).toBeNull();

    await beginLogin(discovery, { ...CONFIG, purpose: "lab", labScenario: "nope" }, store);
    expect(recordLabCallback(new URLSearchParams({ code: "c" }), ISSUER, store)).toBeNull();
    expect(store.getItem(LAB_RESULT_KEY)).toBeNull();
  });

  it("takeLabResult is one-shot and drops malformed/unknown entries", async () => {
    const { store } = await callback("pkce-plain", (state) => ({ error: "invalid_request", state, iss: ISSUER }));
    expect(takeLabResult(store)?.pass).toBe(true);
    expect(takeLabResult(store)).toBeNull();
    store.setItem(LAB_RESULT_KEY, JSON.stringify({ scenario: "evil", outcome: "code", pass: true }));
    expect(takeLabResult(store)).toBeNull();
    store.setItem(LAB_RESULT_KEY, "{not json");
    expect(takeLabResult(store)).toBeNull();
  });
});

describe("state tamper — the REAL callback handler must reject before /token (F3)", () => {
  async function tamperRun(forge: boolean) {
    const store = memStore();
    const tokens = createTokenStore();
    const fetchImpl = vi.fn().mockResolvedValue(tokenResponse({ error: "invalid_grant" }, 400));
    const { url, transient } = await beginLogin(discovery, CONFIG, store);
    const sent = new URL(forge ? tamperState(url, store) : url);
    const params = new URLSearchParams({ code: "abc", state: sent.searchParams.get("state") ?? "", iss: ISSUER });
    expect(takeStateTamperExpectation(params, store)).toBe(forge);
    const finish = (p: URLSearchParams) =>
      handleCallback(
        p,
        { clientId: CLIENT_ID, redirectUri: REDIRECT_URI, issuer: ISSUER },
        { discovery, store, tokens, jwks: vi.fn(), fetchImpl: fetchImpl as unknown as typeof fetch },
      );
    const result = await checkStateTamper(params, finish, store);
    return { result, fetchImpl, store, tokens, transient };
  }

  it("forged state ⇒ PASS, 0 calls to /token, no session, transient consumed", async () => {
    const { result, fetchImpl, store, tokens } = await tamperRun(true);
    expect(result).toEqual({ scenario: "state-tamper", outcome: "rejected", pass: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(tokens.get()).toBeNull();
    expect(readTransient(store)).toBeNull();
    expect(store.getItem(LAB_RESULT_KEY)).not.toContain("abc");
  });

  it("control: genuine state reaches /token, so the check is not tautological (⇒ FAIL)", async () => {
    const { result, fetchImpl } = await tamperRun(false);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result.pass).toBe(false);
  });

  it("a callback that succeeds ⇒ FAIL", async () => {
    const r = await checkStateTamper(new URLSearchParams(), async () => ({}), memStore());
    expect(r).toMatchObject({ outcome: "code", pass: false });
  });

  it("tamperState swaps only state and arms a one-shot flag", async () => {
    const store = memStore();
    const { url } = await beginLogin(discovery, CONFIG, store);
    const forged = new URL(tamperState(url, store));
    expect(changedParams(new URL(url), forged)).toEqual(["state"]);
    expect(forged.searchParams.get("state")).toBe(TAMPERED_STATE);
    const params = new URLSearchParams({ state: TAMPERED_STATE });
    expect(takeStateTamperExpectation(params, store)).toBe(true);
    expect(takeStateTamperExpectation(params, store)).toBe(false);
  });

  it("an armed flag with a different state is consumed but does not trigger the check", () => {
    const store = memStore({ "oidc:lab_expect": "state-tamper" });
    expect(takeStateTamperExpectation(new URLSearchParams({ state: "real" }), store)).toBe(false);
    expect(store.getItem("oidc:lab_expect")).toBeNull();
  });
});

describe("refresh replay (Task 2, INV-10/11) — real refreshSession/postToken over a fake /token", () => {
  type Mode = "correct" | "accepts-replay" | "no-family-revoke" | "replay-5xx" | "no-rotation";

  /** A fake IdP `/token` with rotation + reuse detection; `mode` injects a broken behaviour. */
  function fakeIdp(mode: Mode) {
    const used = new Set<string>();
    let family = true;
    let n = 0;
    return vi.fn(async (_url: string, init?: RequestInit) => {
      const rt = new URLSearchParams(String(init?.body)).get("refresh_token") ?? "";
      if (mode === "replay-5xx" && used.has(rt)) return new Response("", { status: 503 });
      if (!family || (used.has(rt) && mode !== "accepts-replay")) {
        if (mode !== "no-family-revoke") family = false;
        return tokenResponse({ error: "invalid_grant" }, 400);
      }
      used.add(rt);
      const next = mode === "no-rotation" ? rt : `rt-secret-${++n}`;
      if (mode === "no-rotation") used.delete(rt);
      return tokenResponse({ access_token: `at-secret-${n}`, token_type: "Bearer", expires_in: 900, refresh_token: next });
    });
  }

  async function run(mode: Mode) {
    const fetchImpl = fakeIdp(mode) as unknown as typeof fetch;
    const tokens = createTokenStore();
    const initial: Session = {
      accessToken: "at-secret-0",
      idToken: "id",
      refreshToken: "rt-secret-0",
      claims: { iss: ISSUER, sub: "u1", aud: CLIENT_ID, exp: 0, iat: 0 },
      accessTokenExpiresAt: 0,
    };
    tokens.set(initial);
    const steps = await runRefreshReplay({
      currentRefreshToken: () => tokens.get()?.refreshToken,
      refresh: () =>
        refreshSession({ clientId: CLIENT_ID, issuer: ISSUER }, { discovery, tokens, jwks: vi.fn(), fetchImpl }),
      replay: (rt) =>
        postToken(discovery.token_endpoint, { grant_type: "refresh_token", refresh_token: rt, client_id: CLIENT_ID }, fetchImpl),
    });
    return { steps, tokens, fetchImpl };
  }

  it("correct IdP ⇒ all three steps PASS and the session is gone (expected, plan §11)", async () => {
    const { steps, tokens } = await run("correct");
    expect(steps.map((s) => [s.step, s.pass])).toEqual([
      [1, true],
      [2, true],
      [3, true],
    ]);
    expect(tokens.get()).toBeNull();
    expect(JSON.stringify(steps)).not.toMatch(/secret/);
  });

  it("IdP accepting the replay ⇒ step 2 FAIL", async () => {
    const { steps } = await run("accepts-replay");
    expect(steps[1]).toMatchObject({ step: 2, pass: false });
  });

  it("IdP not revoking the family ⇒ step 3 FAIL", async () => {
    const { steps } = await run("no-family-revoke");
    expect(steps[1]).toMatchObject({ step: 2, pass: true });
    expect(steps[2]).toMatchObject({ step: 3, pass: false });
  });

  it("5xx on the replay ⇒ step 2 FAIL as inconclusive (only invalid_grant is green)", async () => {
    const { steps } = await run("replay-5xx");
    expect(steps[1]).toMatchObject({ step: 2, pass: false });
    expect(steps[1].observed).toMatch(/inconclusive/);
  });

  it("no rotation ⇒ stops after step 1 FAIL (no replay sent)", async () => {
    const { steps, fetchImpl } = await run("no-rotation");
    expect(steps).toEqual([expect.objectContaining({ step: 1, pass: false })]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("no refresh token ⇒ step 1 FAIL without any /token call", async () => {
    const replay = vi.fn();
    const steps = await runRefreshReplay({ currentRefreshToken: () => undefined, refresh: vi.fn(), replay });
    expect(steps).toEqual([expect.objectContaining({ step: 1, pass: false })]);
    expect(replay).not.toHaveBeenCalled();
  });

  it("a non-TokenEndpointError failure is never green", async () => {
    let rt = "a";
    const steps = await runRefreshReplay({
      currentRefreshToken: () => rt,
      refresh: vi
        .fn()
        .mockImplementationOnce(async () => {
          rt = "b";
        })
        .mockRejectedValueOnce(new Error("Token endpoint error (invalid_grant)")),
      replay: vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    });
    expect(steps.map((s) => s.pass)).toEqual([true, false, false]);
  });
});

describe("TokenEndpointError (F6)", () => {
  it("carries the sanitised code and keeps the legacy message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(tokenResponse({ error: "invalid_grant" }, 400));
    const err = await postToken(discovery.token_endpoint, {}, fetchImpl as unknown as typeof fetch).catch((e) => e);
    expect(err).toBeInstanceOf(TokenEndpointError);
    expect(err.code).toBe("invalid_grant");
    expect(err.message).toBe("Token endpoint error (invalid_grant)");
  });

  it("uses http_<status> when the body has no error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 502 }));
    const err = await postToken(discovery.token_endpoint, {}, fetchImpl as unknown as typeof fetch).catch((e) => e);
    expect(err.code).toBe("http_502");
  });
});
