/**
 * `redirect_uri` / `postLogoutRedirectUris` validation (B3.1, spec §9.3/D4, INV-4/INV-21).
 *
 * Two separate concerns, deliberately not merged:
 * - `validateRedirectUriFormat` — run once at registration time (Client.redirectUris /
 *   Client.postLogoutRedirectUris): absolute URI, no fragment, no wildcard, `https` only
 *   (tech-lead C1: `http://localhost` allowed only when NOT production, decided by the
 *   caller-supplied `allowHttpLocalhost`, never a hard-coded `NODE_ENV` check in this file).
 * - `matchesRegisteredRedirectUri` — run at request time (future `/authorize`, B4): exact
 *   string equality, no normalisation (no trailing-slash collapsing, no query stripping) —
 *   an attacker adding a trailing slash or extra query string to a registered URI must not
 *   be treated as a match.
 */

export class InvalidRedirectUriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRedirectUriError';
  }
}

export interface RedirectUriValidationOptions {
  /** Allow `http://localhost` (dev/test only). Caller decides from its own env/config. */
  allowHttpLocalhost: boolean;
}

/**
 * Validate the *format* of a single registered redirect URI (or post-logout redirect URI).
 * Throws `InvalidRedirectUriError` with a reason; never normalises or returns a value.
 */
export function validateRedirectUriFormat(uri: string, opts: RedirectUriValidationOptions): void {
  if (uri.includes('*')) {
    throw new InvalidRedirectUriError(`redirect_uri must not contain a wildcard: ${uri}`);
  }

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new InvalidRedirectUriError(`redirect_uri must be an absolute URI: ${uri}`);
  }

  if (parsed.hash) {
    throw new InvalidRedirectUriError(`redirect_uri must not contain a fragment: ${uri}`);
  }

  const isDevLocalhost =
    opts.allowHttpLocalhost && parsed.protocol === 'http:' && parsed.hostname === 'localhost';
  if (parsed.protocol !== 'https:' && !isDevLocalhost) {
    throw new InvalidRedirectUriError(
      `redirect_uri must use https (http://localhost only allowed outside production): ${uri}`,
    );
  }
}

/** Validate every entry of a redirect URI list; throws on the first invalid one. */
export function validateRedirectUriList(
  uris: readonly string[],
  opts: RedirectUriValidationOptions,
): void {
  for (const uri of uris) {
    validateRedirectUriFormat(uri, opts);
  }
}

/**
 * Exact match against a registered redirect URI (INV-4): no trailing-slash normalisation,
 * no query/fragment stripping — plain string equality.
 */
export function matchesRegisteredRedirectUri(registered: string, requested: string): boolean {
  return registered === requested;
}

/** True if `requested` exactly matches one of the client's registered redirect URIs. */
export function isRegisteredRedirectUri(
  registeredUris: readonly string[],
  requested: string,
): boolean {
  return registeredUris.some((registered) => matchesRegisteredRedirectUri(registered, requested));
}
