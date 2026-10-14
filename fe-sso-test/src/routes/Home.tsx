import { useState } from "react";
import { startLogin, logout, tokens } from "../oidc/client";

/**
 * Home: start login, show the signed-in subject, and sign out (RP-initiated). Tokens live only
 * in memory, so a reload returns to the anonymous view. Minimal, semantic, keyboard-navigable.
 */
export default function Home() {
  const session = tokens.get();
  const [error, setError] = useState<string | null>(null);

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
          <button type="button" onClick={onLogout}>
            Sign out
          </button>
        </>
      ) : (
        <>
          <p>OIDC manual-client test app. Not signed in.</p>
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
