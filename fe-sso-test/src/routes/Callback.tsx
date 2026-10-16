import { Link, useRouteError } from "react-router";

/**
 * `/callback`: the code exchange runs in the route loader (see `router.tsx`) — one exchange
 * even though StrictMode double-invokes (F2) because the loader joins the single-flight. On
 * success the loader redirects home; on failure this element renders the error fail-closed.
 */
export default function Callback() {
  return (
    <main>
      <h1>Processing sign-in…</h1>
      <p>Completing the authorization response.</p>
    </main>
  );
}

/** Rendered by React Router when the callback loader throws (fail-closed, no session). */
export function CallbackError() {
  const error = useRouteError();
  const message = error instanceof Error ? error.message : "Sign-in failed.";
  return (
    <main>
      <h1>Sign-in failed</h1>
      <p role="alert" style={{ color: "#b00020" }}>
        {message}
      </p>
      <Link to="/">Back to start</Link>
    </main>
  );
}
