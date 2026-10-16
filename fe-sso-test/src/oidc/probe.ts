import type { Discovery } from "./discovery";
import { postToken } from "./token-exchange";
import { validateIdToken, type IdTokenPolicy } from "./idToken";
import {
  clearTransient,
  isTransientStale,
  readTransient,
  type TransientStore,
} from "./transient";
import { callResource, ResourceNetworkError } from "./resourceCall";
import type { FetchFn } from "./http";

/**
 * sessionStorage key holding the wrong-`aud` probe OUTCOME — status code only (Task 3). It NEVER
 * holds a token; the probe access token is used once (to call `/demo/me`) and discarded. The
 * `/api-test` page reads and deletes it one-shot to render "PASS 401".
 */
export const PROBE_RESULT_KEY = "oidc:probe_result";

/**
 * sessionStorage flag guarding the single `prompt=none` session-restore attempt per probe (Task
 * 3): set before the silent re-login redirect, read+cleared on its callback. It bounds the flow
 * to AT MOST ONE `prompt=none` so a repeated `interaction_required` can never loop.
 */
export const PROBE_RELOGIN_KEY = "oidc:probe_relogin";

/** The expected status of calling a `demo`-only resource with an `other`-aud token (INV-8). */
export const PROBE_EXPECTED_STATUS = 401;

/** Outcome of the wrong-`aud` probe. Status code + the expected code + the token's `aud`. NO token. */
export interface ProbeResult {
  /** HTTP status the demo resource returned for the wrong-`aud` token (`0` = network/CORS/timeout). */
  readonly status: number;
  /** The status we expected (401): INV-8 holds iff `status === expected`. */
  readonly expected: number;
  /** The resource indicator the probe token was minted for (the WRONG audience). */
  readonly aud: string;
}

/** Narrow unknown JSON to a {@link ProbeResult} (fail-closed: reject anything malformed). */
function isProbeResult(v: unknown): v is ProbeResult {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.status === "number" && typeof r.expected === "number" && typeof r.aud === "string"
  );
}

/**
 * Persist ONLY the probe status (never the token). Writes `{status, expected, aud}` to
 * sessionStorage. The access token minted for the wrong `aud` has already served its single
 * purpose (one `/demo/me` call) and is dropped — it never enters the token store or storage.
 */
export function saveProbeResult(store: TransientStore, result: ProbeResult): void {
  store.setItem(PROBE_RESULT_KEY, JSON.stringify(result));
}

/** Read + delete the probe result one-shot. Returns `null` when absent or malformed (fail-closed). */
export function takeProbeResult(store: TransientStore): ProbeResult | null {
  const raw = store.getItem(PROBE_RESULT_KEY);
  store.removeItem(PROBE_RESULT_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isProbeResult(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface ProbeExchangeConfig {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly issuer: string;
  /** The demo resource endpoint to probe with the wrong-`aud` token (`VITE_DEMO_API_URL`). */
  readonly demoApiUrl: string;
  /** The resource indicator the probe token was requested for (the WRONG audience, e.g. `other`). */
  readonly probeResource: string;
}

export interface ProbeExchangeDeps {
  readonly discovery: Discovery;
  readonly store: TransientStore;
  readonly jwks: IdTokenPolicy["jwks"];
  readonly fetchImpl?: FetchFn;
  readonly now?: () => number;
}

/**
 * Finish the wrong-`aud` probe at `/callback` (Task 3, INV-8): the transient carries
 * `purpose:"aud-probe"`, so instead of installing a session we
 *  1. verify `state`/`iss`/freshness (same fail-closed checks as login),
 *  2. exchange the code for the probe token (`aud = probeResource`, scope `openid`),
 *  3. validate the ID token (signature/iss/aud=client/nonce) — the access token stays opaque,
 *  4. call `/demo/me` with that token and record ONLY `{status, expected:401, aud}`,
 *  5. drop the token (it never reaches the in-memory token store or any storage).
 *
 * The transient is consumed (deleted) up front like the login path. A network/CORS/timeout on the
 * `/demo/me` call is recorded as `status: 0` so the UI can still show it failed (fail-closed) — the
 * probe never throws for the resource call itself. The returned value is the recorded result; the
 * caller then kicks off the `prompt=none` session restore.
 */
export async function handleAudProbeCallback(
  params: URLSearchParams,
  config: ProbeExchangeConfig,
  deps: ProbeExchangeDeps,
): Promise<ProbeResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;

  const code = params.get("code");
  const state = params.get("state");
  const iss = params.get("iss");

  const transient = readTransient(deps.store);
  // Consume the transient immediately (F2/OPEN-1): every branch below leaves nothing to replay.
  clearTransient(deps.store);

  if (!transient || transient.purpose !== "aud-probe") {
    throw new Error("No aud-probe in progress; cannot run the probe callback");
  }
  if (!code || !state) {
    throw new Error("Probe response is missing code or state");
  }
  if (state !== transient.state) {
    throw new Error("state mismatch: possible CSRF; rejecting probe callback");
  }
  if (!iss || iss !== config.issuer) {
    throw new Error("iss missing or mismatched: possible mix-up; rejecting probe callback");
  }
  if (isTransientStale(transient, now())) {
    throw new Error("Probe attempt expired; please start again");
  }

  const token = await postToken(
    deps.discovery.token_endpoint,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      code_verifier: transient.verifier,
    },
    fetchImpl,
  );
  if (!token.id_token) {
    throw new Error("Probe token response missing id_token");
  }
  // Validate the ID token exactly as login does (aud === our client). The ACCESS token is opaque:
  // we never decode it — we just replay it against `/demo/me` to observe INV-8 from the RP side.
  const policy: IdTokenPolicy = {
    issuer: config.issuer,
    audience: config.clientId,
    jwks: deps.jwks,
  };
  await validateIdToken(token.id_token, policy, { expectedNonce: transient.nonce });

  // Replay the wrong-`aud` access token against the demo resource. A network/CORS/timeout error
  // is recorded as status 0 (fail-closed) rather than thrown, so the UI always lands back home.
  let status = 0;
  try {
    const res = await callResource(config.demoApiUrl, token.access_token, fetchImpl);
    status = res.status;
  } catch (err) {
    if (!(err instanceof ResourceNetworkError)) throw err;
    status = 0;
  }

  const result: ProbeResult = {
    status,
    expected: PROBE_EXPECTED_STATUS,
    aud: config.probeResource,
  };
  saveProbeResult(deps.store, result);
  // The probe `token` goes out of scope here — never stored, never logged (exposure budget).
  return result;
}
