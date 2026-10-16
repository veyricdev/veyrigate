import { useSearchParams } from "react-router";
import { describeOAuthError } from "../oidc/oauthError";

/**
 * `/error`: render an authorization/token error fail-closed. The `error`/`error_description`
 * query params are UNTRUSTED (reflected from the URL), so we NEVER echo `error_description`
 * verbatim (DEBT-080). `describeOAuthError` maps a recognised `error` code to our own fixed
 * message; unknown/malformed codes collapse to a generic `unknown_error`.
 */
export default function ErrorPage() {
  const [params] = useSearchParams();
  const { code, message } = describeOAuthError(params.get("error"));

  return (
    <main>
      <h1>Sign-in error</h1>
      <p role="alert" style={{ color: "#b00020" }}>
        <span data-testid="error-code">{code}</span>: <span data-testid="error-message">{message}</span>
      </p>
      <a href="/">Back to start</a>
    </main>
  );
}