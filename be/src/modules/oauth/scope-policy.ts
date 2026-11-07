/** Standard OIDC scopes: checked against `Client.scopes` only, never against `Resource.scopes`. */
export const OIDC_SCOPES: readonly string[] = ['openid', 'profile', 'email', 'offline_access'];

/**
 * DEBT-321 (spec §7): the scopes a token for `resource` may carry for this client right now =
 * `Client.scopes ∩ (OIDC ∪ Resource.scopes)`; with no resource, just the client's scopes. Used by
 * `/authorize`, the consent bound, the code exchange re-check and refresh (DEBT-512).
 */
export function grantableScopes(
  clientScopes: readonly string[],
  resourceScopes: readonly string[] | undefined,
): Set<string> {
  if (resourceScopes === undefined) return new Set(clientScopes);
  const onResource = new Set([...OIDC_SCOPES, ...resourceScopes]);
  return new Set(clientScopes.filter((s) => onResource.has(s)));
}
