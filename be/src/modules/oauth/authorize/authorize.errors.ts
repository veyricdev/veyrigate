/**
 * OAuth `/authorize` error model (B4.1, spec §9.2, INV-3).
 *
 * The open-redirect boundary (INV-3) splits errors into two kinds:
 * - `AuthorizeErrorPage`: the request is not yet trusted — `client_id`/`redirect_uri` could
 *   not be validated — so the error MUST be shown on a first-party error page, never redirected
 *   anywhere (an attacker-supplied `redirect_uri` must not receive the user).
 * - `AuthorizeRedirectError`: `client_id`+`redirect_uri` are already validated as registered, so
 *   the error is returned to the RP by redirecting to that exact URI with OAuth `error`
 *   parameters (plus echoed `state` and `iss`, RFC 9207).
 *
 * Only these two are thrown by the authorize flow; the controller maps each to the correct
 * HTTP behaviour.
 */

/** Error that must render a first-party page (no redirect). Thrown before redirect_uri is trusted. */
export class AuthorizeErrorPage extends Error {
  constructor(
    readonly reason: string,
    message = 'The request could not be completed.',
  ) {
    super(message);
    this.name = 'AuthorizeErrorPage';
  }
}

/** OAuth error codes that may be returned to a validated redirect_uri (spec §9.2/§9.4). */
export type AuthorizeOAuthError =
  | 'invalid_request'
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'invalid_target'
  | 'access_denied'
  | 'login_required'
  | 'consent_required'
  | 'interaction_required';

/**
 * Error that must be delivered to the (already validated) redirect_uri as an OAuth redirect.
 *
 * `redirectUri`/`state` are attached by `AuthorizeService.handle()` right where this is thrown
 * (Phase 2 only runs after `redirect_uri` is trusted) so the controller never needs to read them
 * back off the inbound HTTP request `params` â€” which, on the resume-after-login path, no longer
 * carries `redirect_uri`/`state` (those live in the consumed `AuthorizeRequestContext`).
 */
export class AuthorizeRedirectError extends Error {
  redirectUri?: string;
  state?: string;

  constructor(
    readonly error: AuthorizeOAuthError,
    readonly errorDescription: string,
  ) {
    super(error);
    this.name = 'AuthorizeRedirectError';
  }
}
