import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { startLogin } from "../oidc/client";
import { sanitizeReturnTo } from "../returnTo";

/**
 * `/login`: kick off the OIDC code flow. The `returnTo` query (where the guard wanted to send the
 * user) is sanitized here and handed to `startLogin`, which persists it in a transient — NOT in
 * the OAuth `state`. On success the browser is redirected to the IdP; a failure is rendered
 * fail-closed with a link back home. StrictMode double-invokes the effect, so a ref guards against
 * starting the flow twice.
 */
export default function Login() {
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const returnTo = sanitizeReturnTo(params.get("returnTo"));
    startLogin(returnTo).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [params]);

  return (
    <main>
      <h1>Signing in…</h1>
      {error ? (
        <>
          <p role="alert" data-testid="login-error" style={{ color: "#b00020" }}>
            {error}
          </p>
          <a href="/">Back to start</a>
        </>
      ) : (
        <p>Redirecting to the identity provider.</p>
      )}
    </main>
  );
}