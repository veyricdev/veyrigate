/**
 * Fixed, non-secret failure codes of the federation leg (B5.1/B5.2, F2/F9). Rendered as a
 * first-party HTML page — never a redirect to the RP, never provider bodies or `err.message`.
 */
export type FederationErrorCode =
  /** Unknown or disabled provider route. */
  | 'not_found'
  /** `request_id` missing/expired or not a login context. */
  | 'context_expired'
  /** IdP `state` missing/expired/replayed, provider mix-up, or binding cookie mismatch. */
  | 'invalid_state'
  /** Provider returned `error` (e.g. `access_denied`). */
  | 'provider_denied'
  /** Network error, timeout, non-2xx, bad JSON or an error body from the provider. */
  | 'provider_unavailable'
  /** ID token / identity failed verification. */
  | 'invalid_identity'
  /** Re-authentication demanded but the provider cannot prove it. */
  | 'reauth_required'
  /** No provider-verified email for a new account. */
  | 'email_unverified'
  /** Account locked (admin or brute-force). */
  | 'account_locked'
  /** Lost a provisioning race and could not recover; the user may simply retry. */
  | 'retry';

export class FederationError extends Error {
  constructor(readonly code: FederationErrorCode) {
    super(`federation: ${code}`);
    this.name = 'FederationError';
  }
}
