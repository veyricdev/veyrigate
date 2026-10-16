import { useState } from "react";
import { Link } from "react-router";
import {
  tokens,
  refresh,
  replayRefreshToken,
  startLabScenario,
  startStateTamper,
  takeLabResult,
} from "../oidc/client";
import { LAB_SCENARIOS, STATE_TAMPER, runRefreshReplay, type LabResult, type ReplayStep } from "../oidc/lab";

/** Human text per `/authorize` scenario (F1). Kept here so it ships only in the dev-only chunk. */
const SCENARIO_TEXT: Readonly<Record<string, { title: string; inv: string; expected: string }>> = {
  "redirect-uri-mismatch": {
    title: "redirect_uri mismatch (path changed)",
    inv: "INV-4",
    expected:
      "IdP shows its own 400 error page and does NOT redirect back. No result can arrive here — confirmed by E2E.",
  },
  "pkce-plain": {
    title: "code_challenge_method=plain",
    inv: "INV-3",
    expected: "redirect with error=invalid_request + matching state + iss",
  },
  "no-code-challenge": {
    title: "code_challenge removed",
    inv: "INV-3",
    expected: "redirect with error=invalid_request + iss",
  },
  "resource-unknown": {
    title: "resource = unregistered absolute URI",
    inv: "INV-14/15",
    expected: "redirect with error=invalid_target + iss",
  },
  "resource-relative": {
    title: "resource = non-absolute (\"demo\")",
    inv: "INV-14/15",
    expected: "redirect with error=invalid_target + iss",
  },
  "no-nonce": {
    title: "nonce removed",
    inv: "INV-6",
    expected:
      "IdP ACCEPTS (nonce is the RP's job) ⇒ redirect with a code + iss. The RP rejects it in validateIdToken; the lab never exchanges the code.",
  },
  "prompt-none-max-age-0": {
    title: "prompt=none + max_age=0",
    inv: "OIDC prompt",
    expected: "redirect with error=login_required + iss",
  },
  "prompt-none-no-session": {
    title: "prompt=none",
    inv: "OIDC prompt",
    expected:
      "redirect with error=login_required + iss — only when NOT signed in at the IdP (otherwise a code comes back).",
  },
};

const STEP_TEXT: Readonly<Record<ReplayStep["step"], string>> = {
  1: "1 · Refresh once (rotation)",
  2: "2 · Replay the OLD refresh token — expect invalid_grant",
  3: "3 · Refresh with the rotated token — expect invalid_grant (family revoked)",
};

/** Describe a recorded lab result without any token/code/state (only outcome, code, booleans). */
function describeResult(r: LabResult): string {
  const parts: string[] = [r.outcome === "error" ? `error=${r.error ?? "unknown_error"}` : r.outcome];
  if (r.stateOk !== undefined) parts.push(r.stateOk ? "state ok" : "state MISMATCH");
  if (r.issOk !== undefined) parts.push(r.issOk ? "iss ok" : "iss missing/wrong");
  return parts.join(", ");
}

function Verdict({ pass, testid, children }: { pass: boolean; testid: string; children: string }) {
  return (
    <p data-testid={testid} role="status" style={{ color: pass ? "#1b5e20" : "#b00020" }}>
      <strong>{pass ? "PASS" : "FAIL"}</strong> — {children}
    </p>
  );
}

/**
 * `/lab` (dev only, run 25 T5): the client-side security lab. Three checks:
 *  - Refresh replay (INV-10/11): rotate, replay the old refresh token, then try the descendant.
 *  - `/authorize` scenarios: one parameter altered on a genuine `beginLogin` URL (F1).
 *  - `state` tamper: a genuine login whose returned `state` is forged must be rejected (F3).
 * Not route-guarded (F4); only the refresh replay needs a session. No token is ever rendered.
 */
export default function Lab() {
  const session = tokens.get();
  // The one-shot result of the redirect flow that just returned here (read + delete once).
  const [result] = useState<LabResult | null>(takeLabResult);
  const [steps, setSteps] = useState<ReplayStep[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onReplay() {
    setBusy(true);
    try {
      setSteps(
        await runRefreshReplay({
          currentRefreshToken: () => tokens.get()?.refreshToken,
          refresh,
          replay: replayRefreshToken,
        }),
      );
    } finally {
      setBusy(false);
    }
  }

  function navigate(start: () => Promise<void>) {
    setBusy(true);
    setError(null);
    start().catch(() => {
      setBusy(false);
      setError("Could not start the flow (discovery unavailable?).");
    });
  }

  return (
    <main>
      <h1>Security lab</h1>
      <p>Dev-only checks of the IdP and this client. Each result is scored against an expected outcome.</p>
      {error ? (
        <p role="alert" style={{ color: "#b00020" }}>
          {error}
        </p>
      ) : null}

      <section aria-labelledby="lab-replay-h" data-testid="lab-replay">
        <h2 id="lab-replay-h">Refresh-token replay (INV-10/11)</h2>
        {session ? (
          <button type="button" data-testid="lab-replay-run" onClick={onReplay} disabled={busy}>
            Run refresh replay
          </button>
        ) : (
          <p data-testid="lab-replay-signin">
            Needs a session. <Link to="/login?returnTo=/lab">Sign in</Link>
          </p>
        )}
        {steps ? (
          <>
            <ol data-testid="lab-replay-steps">
              {steps.map((s) => (
                <li key={s.step}>
                  {STEP_TEXT[s.step]}
                  <Verdict pass={s.pass} testid={`lab-replay-step-${s.step}`}>
                    {s.observed}
                  </Verdict>
                </li>
              ))}
            </ol>
            <p data-testid="lab-replay-note">
              Losing the session now is CORRECT: this is a public client with strict refresh-token
              rotation, so a revoked family forces a new sign-in (plan §11).{" "}
              <Link to="/login?returnTo=/lab">Sign in again</Link>
            </p>
          </>
        ) : null}
      </section>

      <section aria-labelledby="lab-authorize-h" data-testid="lab-authorize">
        <h2 id="lab-authorize-h">/authorize parameter tampering</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">Scenario</th>
              <th scope="col">Invariant</th>
              <th scope="col">Expected</th>
              <th scope="col">Result</th>
              <th scope="col">Run</th>
            </tr>
          </thead>
          <tbody>
            {LAB_SCENARIOS.map((s) => {
              const text = SCENARIO_TEXT[s.id];
              return (
                <tr key={s.id} data-testid={`lab-scenario-${s.id}`}>
                  <th scope="row">{text.title}</th>
                  <td>{text.inv}</td>
                  <td>{text.expected}</td>
                  <td>
                    {result?.scenario === s.id ? (
                      <Verdict pass={result.pass} testid={`lab-result-${s.id}`}>
                        {describeResult(result)}
                      </Verdict>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      data-testid={`lab-run-${s.id}`}
                      disabled={busy}
                      onClick={() => navigate(() => startLabScenario(s.id))}
                    >
                      Run
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="lab-state-h" data-testid="lab-state">
        <h2 id="lab-state-h">Forged state on the callback</h2>
        <p>
          Starts a genuine sign-in but swaps <code>state</code> on the way out. The real callback
          handler must reject it before any <code>/token</code> call.
        </p>
        <button
          type="button"
          data-testid="lab-run-state-tamper"
          disabled={busy}
          onClick={() => navigate(startStateTamper)}
        >
          Run state tamper
        </button>
        {result?.scenario === STATE_TAMPER ? (
          <Verdict pass={result.pass} testid="lab-result-state-tamper">
            {result.pass ? "callback rejected: state mismatch" : `not rejected as expected (${result.outcome})`}
          </Verdict>
        ) : null}
      </section>

      <nav>
        <Link to="/">Home</Link>
      </nav>
    </main>
  );
}
