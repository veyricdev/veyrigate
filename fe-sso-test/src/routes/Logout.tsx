import { useEffect, useState } from "react";
import { Link } from "react-router";
import { logout } from "../oidc/client";

/**
 * `/logout`: clear the in-memory session and redirect to the IdP end-session endpoint
 * (RP-initiated logout). When there is no session `logout()` returns null and we show a notice
 * with a link home. StrictMode double-invokes the effect, so a module-local flag keeps the
 * navigation one-shot.
 */
export default function Logout() {
  const [error, setError] = useState<string | null>(null);
  const [anonymous, setAnonymous] = useState(false);

  useEffect(() => {
    let cancelled = false;
    logout()
      .then((url) => {
        if (cancelled) return;
        if (url) window.location.assign(url);
        else setAnonymous(true);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      <h1>Signing out…</h1>
      {error ? (
        <>
          <p role="alert" style={{ color: "#b00020" }}>
            {error}
          </p>
          <Link to="/">Back to start</Link>
        </>
      ) : anonymous ? (
        <>
          <p role="status" data-testid="logout-anonymous">
            You are not signed in.
          </p>
          <Link to="/">Back to start</Link>
        </>
      ) : (
        <p>Redirecting to the identity provider.</p>
      )}
    </main>
  );
}