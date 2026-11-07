import { grantableScopes, OIDC_SCOPES } from './scope-policy';

/** DEBT-321: the one rule shared by /authorize, consent, the code exchange and refresh. */
describe('grantableScopes', () => {
  it('is the intersection, not the union, of client and resource scopes', () => {
    const got = grantableScopes(['openid', 'api.read'], ['api.read', 'api.write']);
    expect([...got].sort()).toEqual(['api.read', 'openid']);
  });

  it('keeps the standard OIDC scopes of the client when the resource lists none', () => {
    const got = grantableScopes([...OIDC_SCOPES, 'api.read'], []);
    expect([...got].sort()).toEqual([...OIDC_SCOPES].sort());
  });

  it('is the client scopes when there is no resource', () => {
    const got = grantableScopes(['openid', 'api.read'], undefined);
    expect([...got].sort()).toEqual(['api.read', 'openid']);
  });

  it('drops a scope the resource lists but the client does not', () => {
    const got = grantableScopes(['openid'], ['api.read', 'profile']);
    expect([...got]).toEqual(['openid']);
  });
});
