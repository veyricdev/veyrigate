import { deriveS256Challenge } from './pkce.util';

describe('deriveS256Challenge (PKCE S256)', () => {
  it('matches the RFC 7636 Appendix B test vector', () => {
    // RFC 7636 Appendix B: verifier → challenge
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const expectedChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(deriveS256Challenge(verifier)).toBe(expectedChallenge);
  });

  it('produces base64url output (no padding, url-safe alphabet)', () => {
    const challenge = deriveS256Challenge('some-random-verifier-value-1234567890');
    expect(challenge).not.toContain('=');
    expect(challenge).not.toContain('+');
    expect(challenge).not.toContain('/');
  });
});
