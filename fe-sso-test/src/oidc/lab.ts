import { clearTransient, readTransient, type TransientStore } from "./transient";
import { describeOAuthError } from "./oauthError";
import { TokenEndpointError } from "./token-exchange";

/**
 * Dev-only security lab (run 25, plan T5). Pure logic only — no env, no `window`; the wiring lives
 * in `client.ts` and the UI in `routes/Lab.tsx` (lazy, absent from production builds).
 *
 * Exposure budget (same as runs 21–24): no token, `code` or `state` is ever rendered or stored.
 * The one-shot result below holds only a scenario id, an outcome, a whitelisted error code and
 * booleans.
 */

/** What a `/authorize` scenario should produce when the IdP behaves correctly (tech-lead F1). */
export type LabExpectation =
  | { readonly kind: "no-redirect" }
  | { readonly kind: "error"; readonly error: string }
  | { readonly kind: "code" };

export interface LabScenario {
  readonly id: string;
  readonly expect: LabExpectation;
  /** Change the scenario's parameter(s) on a URL built by `beginLogin` (no second builder). */
  readonly mutate: (params: URLSearchParams, issuer: string) => void;
}

/** The `/authorize` scenarios (F1), in `authorize.service.ts handle()` check order. */
export const LAB_SCENARIOS: readonly LabScenario[] = [
  {
    id: "redirect-uri-mismatch",
    expect: { kind: "no-redirect" },
    mutate: (p) => {
      const u = new URL(p.get("redirect_uri") ?? "");
      u.pathname += "-x";
      p.set("redirect_uri", u.toString());
    },
  },
  {
    id: "pkce-plain",
    expect: { kind: "error", error: "invalid_request" },
    mutate: (p) => p.set("code_challenge_method", "plain"),
  },
  {
    id: "no-code-challenge",
    expect: { kind: "error", error: "invalid_request" },
    mutate: (p) => p.delete("code_challenge"),
  },
  {
    id: "resource-unknown",
    expect: { kind: "error", error: "invalid_target" },
    mutate: (p, issuer) => p.set("resource", `${issuer.replace(/\/+$/, "")}/unknown/`),
  },
  {
    id: "resource-relative",
    expect: { kind: "error", error: "invalid_target" },
    mutate: (p) => p.set("resource", "demo"),
  },
  {
    id: "no-nonce",
    expect: { kind: "code" },
    mutate: (p) => p.delete("nonce"),
  },
  {
    id: "prompt-none-max-age-0",
    expect: { kind: "error", error: "login_required" },
    mutate: (p) => {
      p.set("prompt", "none");
      p.set("max_age", "0");
    },
  },
  {
    id: "prompt-none-no-session",
    expect: { kind: "error", error: "login_required" },
    mutate: (p) => p.set("prompt", "none"),
  },
];

export function findLabScenario(id: unknown): LabScenario | undefined {
  return LAB_SCENARIOS.find((s) => s.id === id);
}

/** Apply a scenario to an `/authorize` URL produced by `beginLogin`. */
export function buildScenarioUrl(authorizeUrl: string, scenario: LabScenario, issuer: string): string {
  const url = new URL(authorizeUrl);
  scenario.mutate(url.searchParams, issuer);
  return url.toString();
}

/** Id of the `state`-tamper check (Task 3c). */
export const STATE_TAMPER = "state-tamper";

/** One-shot result of a lab redirect, shown once on `/lab`. Never holds a token/code/state. */
export interface LabResult {
  readonly scenario: string;
  readonly outcome: "error" | "code" | "rejected";
  /** Whitelisted OAuth error code (`describeOAuthError`), only when `outcome === "error"`. */
  readonly error?: string;
  readonly issOk?: boolean;
  readonly stateOk?: boolean;
  readonly pass: boolean;
}

export const LAB_RESULT_KEY = "oidc:lab_result";
export const LAB_EXPECT_KEY = "oidc:lab_expect";
/** The forged `state` sent by the tamper check; the transient keeps the genuine one. */
export const TAMPERED_STATE = "lab-tampered-state";

function saveResult(store: TransientStore, result: LabResult): LabResult {
  store.setItem(LAB_RESULT_KEY, JSON.stringify(result));
  return result;
}

/** True when the pending `/callback` belongs to a lab `/authorize` scenario. */
export function isLabCallbackPending(store: TransientStore): boolean {
  return readTransient(store)?.purpose === "lab";
}

/**
 * Record a lab scenario callback (F2). The transient is consumed first (one-shot). The code, if
 * any, is NEVER exchanged. Only a callback whose `state` matches the transient can score PASS, and
 * only with `iss` present and equal to the issuer. Returns null (nothing recorded) when the
 * transient is missing, not a lab one, or names an unknown scenario.
 */
export function recordLabCallback(
  params: URLSearchParams,
  issuer: string,
  store: TransientStore,
): LabResult | null {
  const transient = readTransient(store);
  clearTransient(store);
  const scenario = findLabScenario(transient?.labScenario);
  if (!transient || transient.purpose !== "lab" || !scenario) return null;

  const stateOk = params.get("state") === transient.state;
  const issOk = params.get("iss") === issuer;
  if (!stateOk) {
    return saveResult(store, { scenario: scenario.id, outcome: "rejected", issOk, stateOk, pass: false });
  }
  const rawError = params.get("error");
  const outcome = rawError ? "error" : params.has("code") ? "code" : "rejected";
  const error = rawError ? describeOAuthError(rawError).code : undefined;
  const expect = scenario.expect;
  const matches =
    expect.kind === "error"
      ? outcome === "error" && error === expect.error
      : expect.kind === "code" && outcome === "code";
  return saveResult(store, {
    scenario: scenario.id,
    outcome,
    ...(error ? { error } : {}),
    issOk,
    stateOk,
    pass: issOk && matches,
  });
}

/** Swap `state` on a genuine `/authorize` URL and arm the one-shot tamper check (F3). */
export function tamperState(authorizeUrl: string, store: TransientStore): string {
  const url = new URL(authorizeUrl);
  url.searchParams.set("state", TAMPERED_STATE);
  store.setItem(LAB_EXPECT_KEY, STATE_TAMPER);
  return url.toString();
}

/** Read + clear the tamper flag; true only when armed AND this callback carries the forged state. */
export function takeStateTamperExpectation(params: URLSearchParams, store: TransientStore): boolean {
  const armed = store.getItem(LAB_EXPECT_KEY) === STATE_TAMPER;
  store.removeItem(LAB_EXPECT_KEY);
  return armed && params.get("state") === TAMPERED_STATE;
}

/**
 * Run the REAL callback handler (`finish` = `finishLogin`) on the forged-state callback (F3). PASS
 * only when it rejects with the state-mismatch error; any success (a session was installed) or a
 * different failure is FAIL. The comparison itself is never re-implemented here.
 */
export async function checkStateTamper(
  params: URLSearchParams,
  finish: (params: URLSearchParams) => Promise<unknown>,
  store: TransientStore,
): Promise<LabResult> {
  try {
    await finish(params);
    return saveResult(store, { scenario: STATE_TAMPER, outcome: "code", pass: false });
  } catch (err) {
    const pass = err instanceof Error && err.message.startsWith("state mismatch");
    return saveResult(store, { scenario: STATE_TAMPER, outcome: "rejected", pass });
  }
}

const OUTCOMES = new Set(["error", "code", "rejected"]);

/** Read + delete the one-shot lab result; anything malformed or unknown is dropped. */
export function takeLabResult(store: TransientStore): LabResult | null {
  const raw = store.getItem(LAB_RESULT_KEY);
  store.removeItem(LAB_RESULT_KEY);
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Partial<LabResult>;
    const knownScenario = r.scenario === STATE_TAMPER || findLabScenario(r.scenario) !== undefined;
    if (!knownScenario || typeof r.pass !== "boolean" || !OUTCOMES.has(r.outcome ?? "")) return null;
    return {
      scenario: r.scenario as string,
      outcome: r.outcome as LabResult["outcome"],
      ...(r.error !== undefined ? { error: describeOAuthError(r.error).code } : {}),
      ...(typeof r.issOk === "boolean" ? { issOk: r.issOk } : {}),
      ...(typeof r.stateOk === "boolean" ? { stateOk: r.stateOk } : {}),
      pass: r.pass,
    };
  } catch {
    return null;
  }
}

/** One scored step of the refresh-replay check (Task 2, INV-10/11). No token is ever included. */
export interface ReplayStep {
  readonly step: 1 | 2 | 3;
  readonly pass: boolean;
  readonly observed: string;
}

export interface RefreshReplayDeps {
  /** The refresh token currently in the in-memory session. */
  readonly currentRefreshToken: () => string | undefined;
  /** The app's single-flight refresh (updates the store; clears it on failure). */
  readonly refresh: () => Promise<unknown>;
  /** POST `grant_type=refresh_token` with the given (old) token, bypassing the store. */
  readonly replay: (refreshToken: string) => Promise<unknown>;
}

/** Score a `/token` failure: only a structured `invalid_grant` is green (F6, fail-closed). */
function expectInvalidGrant(err: unknown): { pass: boolean; observed: string } {
  if (err instanceof TokenEndpointError) {
    return err.code === "invalid_grant"
      ? { pass: true, observed: "rejected with invalid_grant" }
      : { pass: false, observed: `rejected with ${err.code} — inconclusive` };
  }
  return { pass: false, observed: "network/unexpected error — inconclusive" };
}

/**
 * Refresh-token replay (INV-10/11): (1) refresh once so the token rotates, (2) replay the OLD
 * token ⇒ expect `invalid_grant` (reuse detected, family revoked), (3) refresh with the rotated
 * descendant ⇒ expect `invalid_grant` too. The old token lives only in this function's local
 * variable — never in state, storage or the DOM. Losing the session afterwards is CORRECT.
 */
export async function runRefreshReplay(deps: RefreshReplayDeps): Promise<ReplayStep[]> {
  const oldToken = deps.currentRefreshToken();
  if (!oldToken) {
    return [{ step: 1, pass: false, observed: "no refresh_token in the session — inconclusive" }];
  }
  const steps: ReplayStep[] = [];
  try {
    await deps.refresh();
  } catch (err) {
    steps.push({ step: 1, pass: false, observed: `refresh failed: ${expectInvalidGrant(err).observed}` });
    return steps;
  }
  const rotated = deps.currentRefreshToken();
  if (!rotated || rotated === oldToken) {
    steps.push({ step: 1, pass: false, observed: "refresh_token was not rotated — inconclusive" });
    return steps;
  }
  steps.push({ step: 1, pass: true, observed: "refreshed; refresh_token rotated" });

  try {
    await deps.replay(oldToken);
    steps.push({ step: 2, pass: false, observed: "old refresh_token was ACCEPTED (reuse not detected)" });
  } catch (err) {
    steps.push({ step: 2, ...expectInvalidGrant(err) });
  }

  try {
    await deps.refresh();
    steps.push({ step: 3, pass: false, observed: "descendant refresh_token still works (family not revoked)" });
  } catch (err) {
    steps.push({ step: 3, ...expectInvalidGrant(err) });
  }
  return steps;
}
