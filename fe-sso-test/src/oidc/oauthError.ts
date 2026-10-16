/**
 * Safe mapping of OAuth/OIDC `error` codes to controlled, human-readable messages (DEBT-080,
 * closed run 22). The `error` and `error_description` query params on an authorization/token
 * error response are UNTRUSTED input reflected from the URL; echoing `error_description` verbatim
 * is a reflected-XSS / message-spoofing vector. We therefore NEVER render `error_description`:
 * the UI shows only the recognised `error` code plus our own fixed description.
 *
 * Codes cover RFC 6749 §4.1.2.1 (authorization) and OIDC Core §3.1.2.6. An unknown/garbage code
 * is reported generically (and the raw code is not trusted for display — see `describeOAuthError`).
 */
const SAFE_MESSAGES: Readonly<Record<string, string>> = {
  invalid_request: "The sign-in request was malformed.",
  unauthorized_client: "This client is not allowed to sign in this way.",
  access_denied: "Sign-in was denied.",
  unsupported_response_type: "The sign-in request used an unsupported response type.",
  invalid_scope: "The requested scope is invalid.",
  server_error: "The identity provider reported an error.",
  temporarily_unavailable: "The identity provider is temporarily unavailable.",
  interaction_required: "Additional interaction is required to sign in.",
  login_required: "You need to sign in again.",
  account_selection_required: "Please select an account to continue.",
  consent_required: "Consent is required to continue.",
  invalid_request_uri: "The sign-in request URI was invalid.",
  invalid_request_object: "The sign-in request object was invalid.",
  request_not_supported: "This sign-in request parameter is not supported.",
  request_uri_not_supported: "This sign-in request parameter is not supported.",
  registration_not_supported: "This sign-in request parameter is not supported.",
};

/** Only recognised codes (lowercase a-z + underscore) are ever echoed back to the UI. */
const CODE_SHAPE = /^[a-z_]+$/;

/** The controlled description of an OAuth error (never the IdP-supplied `error_description`). */
export interface SafeOAuthError {
  /** The recognised error code, or `"unknown_error"` when unrecognised/malformed. */
  readonly code: string;
  /** Our own fixed message for that code — safe to render as text. */
  readonly message: string;
}

/**
 * Map an untrusted `error` code to a {@link SafeOAuthError}. Unknown or malformed codes become
 * `unknown_error` with a generic message, so no attacker-controlled text ever reaches the DOM.
 * `error_description` is intentionally ignored.
 */
export function describeOAuthError(error: string | null | undefined): SafeOAuthError {
  if (typeof error === "string" && CODE_SHAPE.test(error) && error in SAFE_MESSAGES) {
    return { code: error, message: SAFE_MESSAGES[error] };
  }
  return { code: "unknown_error", message: "Sign-in failed." };
}