import { useEffect, useState } from "react";
import { startLogin, logout, consumeLogout, tokens } from "../oidc/client";

/** Audience may be a string or array; render it stably for the claims panel. */
function formatAud(aud: string | string[]): string {
  return Array.isArray(aud) ? aud.join(", ") : aud;
}

/** Render an epoch-seconds `exp` as ISO-8601 UTC, falling back to the raw value if unparsable. */
function formatExp(exp: number): string {
  const d = new Date(exp * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString() : String(exp);
}

/**
 * Home: start login, show the signed-in subject + a safe claims panel, and sign out
 * (RP-initiated). Tokens live only in memory, so a reload returns to the anonymous view. Only
 * ID-token claims are shown (`sub`/`iss`/`aud`/`exp`); access/refresh tokens are NEVER rendered.
 * Minimal, semantic, keyboard-navigable.
 */
export default function Home() {
  const session = tokens.get();
  const [error, setError] = useState<string | null>(null);

  // Post-logout landing (DEBT-079): if the IdP redirected back here with a `state`, verify it
  // one-shot/fail-closed in a lazy initializer (runs once, so the state is consumed exactly once).
  // A matching state confirms a clean sign-out; a wrong/missing state is treated neutrally (no
  // success claim) — the `state` is still consumed. The URL is cleaned in the effect below.
  const [landing] = useState(() => consumeLogout(window.location.search));
  const signedOut = landing.confirmed;

  // Strip the consumed `state` (and keep any other params) from the URL so it cannot linger or
  // be replayed. Side-effect only — no setState — once the landing has been decided above.
  useEffect(() => {
    if (!landing.handled) return;
    const url = window.location.pathname + landing.cleanedSearch + window.location.hash;
    window.history.replaceState(null, "", url);
  }, [landing]);

  async function onLogin() {
    setError(null);
    try {
      await startLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onLogout() {
    setError(null);
    try {
      const url = await logout();
      if (url) window.location.assign(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <main>
      <h1>fe-sso-test</h1>
      {session ? (
        <>
          <p>
            Signed in as <strong>{session.claims.sub}</strong>.
          </p>
          <dl data-testid="claims">
            <dt>sub</dt>
            <dd data-testid="claim-sub">{session.claims.sub}</dd>
            <dt>iss</dt>
            <dd data-testid="claim-iss">{session.claims.iss}</dd>
            <dt>aud</dt>
            <dd data-testid="claim-aud">{formatAud(session.claims.aud)}</dd>
            <dt>exp</dt>
            <dd data-testid="claim-exp">{formatExp(session.claims.exp)}</dd>
          </dl>
          <nav aria-label="Signed-in navigation" data-testid="nav">
            <a href="/profile">Profile</a> · <a href="/tokens">Tokens</a> ·{" "}
            <a href="/api-test">API test</a>
          </nav>
          <button type="button" onClick={onLogout}>
            Sign out
          </button>
        </>
      ) : (
        <>
          <p>OIDC manual-client test app. Not signed in.</p>
          {signedOut ? (
            <p role="status" data-testid="signed-out">
              You have been signed out.
            </p>
          ) : null}
          <button type="button" onClick={onLogin}>
            Sign in
          </button>
        </>
      )}
      {error ? (
        <p role="alert" style={{ color: "#b00020" }}>
          {error}
        </p>
      ) : null}
    </main>
  );
}
