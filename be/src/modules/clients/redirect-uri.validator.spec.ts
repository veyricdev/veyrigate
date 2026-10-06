import {
  InvalidRedirectUriError,
  isRegisteredRedirectUri,
  validateRedirectUriFormat,
  validateRedirectUriList,
} from './redirect-uri.validator';

describe('redirect-uri.validator (B3.1, INV-4/INV-21, tech-lead C1)', () => {
  describe('validateRedirectUriFormat — production (allowHttpLocalhost=false)', () => {
    const opts = { allowHttpLocalhost: false };

    it('accepts a plain https absolute URI', () => {
      expect(() =>
        validateRedirectUriFormat('https://app.example.com/callback', opts),
      ).not.toThrow();
    });

    it('rejects http://localhost in production', () => {
      expect(() => validateRedirectUriFormat('http://localhost:3000/callback', opts)).toThrow(
        InvalidRedirectUriError,
      );
    });

    it('rejects a relative/non-absolute string', () => {
      expect(() => validateRedirectUriFormat('/callback', opts)).toThrow(InvalidRedirectUriError);
      expect(() => validateRedirectUriFormat('not a url', opts)).toThrow(InvalidRedirectUriError);
    });

    it('rejects a fragment', () => {
      expect(() =>
        validateRedirectUriFormat('https://app.example.com/callback#frag', opts),
      ).toThrow(InvalidRedirectUriError);
    });

    it('rejects a wildcard anywhere in the URI, including subdomain wildcard', () => {
      expect(() => validateRedirectUriFormat('https://*.example.com/callback', opts)).toThrow(
        InvalidRedirectUriError,
      );
      expect(() => validateRedirectUriFormat('https://app.example.com/*', opts)).toThrow(
        InvalidRedirectUriError,
      );
    });

    it('rejects non-https schemes (http, ftp)', () => {
      expect(() => validateRedirectUriFormat('http://app.example.com/callback', opts)).toThrow(
        InvalidRedirectUriError,
      );
      expect(() => validateRedirectUriFormat('ftp://app.example.com/callback', opts)).toThrow(
        InvalidRedirectUriError,
      );
    });
  });

  describe('validateRedirectUriFormat — dev (allowHttpLocalhost=true)', () => {
    const opts = { allowHttpLocalhost: true };

    it('accepts http://localhost', () => {
      expect(() => validateRedirectUriFormat('http://localhost:3000/callback', opts)).not.toThrow();
    });

    it('still rejects http on a non-localhost host', () => {
      expect(() => validateRedirectUriFormat('http://app.example.com/callback', opts)).toThrow(
        InvalidRedirectUriError,
      );
    });

    it('still rejects wildcard and fragment', () => {
      expect(() => validateRedirectUriFormat('http://*.localhost/callback', opts)).toThrow(
        InvalidRedirectUriError,
      );
      expect(() => validateRedirectUriFormat('http://localhost/callback#x', opts)).toThrow(
        InvalidRedirectUriError,
      );
    });
  });

  describe('validateRedirectUriList', () => {
    it('throws on the first invalid entry in a list', () => {
      expect(() =>
        validateRedirectUriList(['https://app.example.com/cb', 'https://*.example.com/cb'], {
          allowHttpLocalhost: false,
        }),
      ).toThrow(InvalidRedirectUriError);
    });

    it('accepts a list of all-valid entries', () => {
      expect(() =>
        validateRedirectUriList(['https://app.example.com/cb', 'https://other.example.com/cb'], {
          allowHttpLocalhost: false,
        }),
      ).not.toThrow();
    });
  });

  describe('isRegisteredRedirectUri — exact match only (INV-4)', () => {
    const registered = ['https://app.example.com/callback'];

    it('matches the exact registered URI', () => {
      expect(isRegisteredRedirectUri(registered, 'https://app.example.com/callback')).toBe(true);
    });

    it('rejects a trailing slash variant', () => {
      expect(isRegisteredRedirectUri(registered, 'https://app.example.com/callback/')).toBe(false);
    });

    it('rejects an extra query string', () => {
      expect(isRegisteredRedirectUri(registered, 'https://app.example.com/callback?x=1')).toBe(
        false,
      );
    });

    it('rejects a subdomain variant', () => {
      expect(isRegisteredRedirectUri(registered, 'https://evil.app.example.com/callback')).toBe(
        false,
      );
    });

    it('rejects an unregistered URI entirely', () => {
      expect(isRegisteredRedirectUri(registered, 'https://other.example.com/callback')).toBe(false);
    });
  });
});
