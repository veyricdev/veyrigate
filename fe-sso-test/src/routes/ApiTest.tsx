import { useCallback, useState } from "react";
import {
  tokens,
  startAudProbe,
  takeProbeResult,
  demoApiUrl,
  userinfoUrl,
} from "../oidc/client";
import { callResource, ResourceNetworkError } from "../oidc/resourceCall";

/** Outcome of one check: scored PASS/FAIL against an EXPECTED status (never a server "reason"). */
interface CheckOutcome {
  readonly pass: boolean;
  /** Human-readable summary (status + outcome). Contains no token — only status + decoded claims. */
  readonly summary: string;
  /** The `sub` claim pulled from a JSON body, when present (so A/C can be cross-checked vs /profile). */
  readonly sub?: string;
}

/** Pull `sub` off a parsed JSON body if it is a string (metadata only — never a token). */
function subOf(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null) {
    const s = (body as Record<string, unknown>).sub;
    if (typeof s === "string") return s;
  }
  return undefined;
}

/**
 * Read + delete the one-shot wrong-`aud` probe result (status only) and score it against INV-8.
 * Done in a `useState` initializer (not an effect) so it runs exactly once at first render when
 * the redirect chain lands back on `/api-test`. `null` when there was no pending probe.
 */
function initialProbeOutcome(): CheckOutcome | null {
  const r = takeProbeResult();
  if (!r) return null;
  return {
    pass: r.status === r.expected,
    summary:
      r.status === 0
        ? `network error calling the demo resource with the wrong-aud token (expected ${r.expected})`
        : `HTTP ${r.status} (expected ${r.expected}) — token aud=${r.aud}`,
  };
}

/**
 * `/api-test`: the T4 resource-call security lab (Task 3, plan §258, INV-8). Three checks, each
 * scored PASS/FAIL against an EXPECTED status code (we never trust a server-supplied "reason"):
 *  - A `/demo/me` with the CURRENT access token (`aud=demo`)   → expect 200.
 *  - B wrong-`aud` probe (redirect chain, keeps the main session) → expect 401 (INV-8).
 *  - C `/userinfo` with the current access token                 → expect 200.
 *
 * No raw token is ever rendered — only status codes and decoded claims. Behind the route guard.
 */
export default function ApiTest() {
  const session = tokens.get();
  const [demoResult, setDemoResult] = useState<CheckOutcome | null>(null);
  const [userinfoResult, setUserinfoResult] = useState<CheckOutcome | null>(null);
  // Read the one-shot probe result once at first render (the redirect chain lands back here).
  const [probeResult] = useState<CheckOutcome | null>(initialProbeOutcome);
  const [busy, setBusy] = useState(false);

  const runDemo = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    try {
      const res = await callResource(demoApiUrl(), session.accessToken);
      setDemoResult({
        pass: res.status === 200,
        summary: `HTTP ${res.status} (expected 200)`,
        sub: subOf(res.body),
      });
    } catch (err) {
      setDemoResult({
        pass: false,
        summary: err instanceof ResourceNetworkError ? "network error" : "unexpected error",
      });
    } finally {
      setBusy(false);
    }
  }, [session]);

  const runUserinfo = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    try {
      const res = await callResource(userinfoUrl(), session.accessToken);
      setUserinfoResult({
        pass: res.status === 200,
        summary: `HTTP ${res.status} (expected 200)`,
        sub: subOf(res.body),
      });
    } catch (err) {
      setUserinfoResult({
        pass: false,
        summary: err instanceof ResourceNetworkError ? "network error" : "unexpected error",
      });
    } finally {
      setBusy(false);
    }
  }, [session]);

  const runProbe = useCallback(async () => {
    setBusy(true);
    // Navigates away (revoke → /authorize for `other`). The result lands back here via the chain.
    await startAudProbe().catch(() => setBusy(false));
  }, []);

  if (!session) {
    return (
      <main>
        <h1>API test</h1>
        <p role="status">Not signed in.</p>
        <a href="/">Back to start</a>
      </main>
    );
  }

  return (
    <main>
      <h1>API test</h1>
      <p>Call protected resources and inspect pass/fail results (scored by expected status code).</p>
      <section data-testid="api-test-actions" aria-label="API test actions">
        <button type="button" data-testid="btn-demo" onClick={runDemo} disabled={busy}>
          A · Call <code>/demo/me</code> (correct aud)
        </button>
        <button type="button" data-testid="btn-probe" onClick={runProbe} disabled={busy}>
          B · Wrong-aud probe (expect 401)
        </button>
        <button type="button" data-testid="btn-userinfo" onClick={runUserinfo} disabled={busy}>
          C · Call <code>/userinfo</code>
        </button>
      </section>
      <section data-testid="api-test-results" aria-label="API test results" aria-live="polite">
        <ResultPanel testid="result-demo" title="A · /demo/me" outcome={demoResult} />
        <ResultPanel
          testid="result-probe"
          title="B · wrong-aud probe"
          outcome={probeResult}
          explanation="INV-8: a token minted for aud=other must NOT open the demo resource — the RP observes 401. A 401 here is the expected PASS."
        />
        <ResultPanel testid="result-userinfo" title="C · /userinfo" outcome={userinfoResult} />
      </section>
      <nav>
        <a href="/">Home</a>
      </nav>
    </main>
  );
}

/** One result row: PASS/FAIL badge + status summary + optional `sub` + optional INV explanation. */
function ResultPanel({
  testid,
  title,
  outcome,
  explanation,
}: {
  testid: string;
  title: string;
  outcome: CheckOutcome | null;
  explanation?: string;
}) {
  return (
    <div data-testid={testid}>
      <h2>{title}</h2>
      {outcome ? (
        <>
          <p data-testid={`${testid}-verdict`} role="status">
            <strong>{outcome.pass ? "PASS" : "FAIL"}</strong> — {outcome.summary}
          </p>
          {outcome.sub ? <p data-testid={`${testid}-sub`}>sub: {outcome.sub}</p> : null}
        </>
      ) : (
        <p data-testid={`${testid}-idle`}>not run yet</p>
      )}
      {explanation ? <p data-testid={`${testid}-inv8`}>{explanation}</p> : null}
    </div>
  );
}