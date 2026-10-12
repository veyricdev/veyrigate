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

    // B4.7 hardening: a stored redirect/post-logout URI is later reflected into a CSP front-channel
    // `frame-src` allowlist, where `;` / `,` terminate or inject a directive. WHATWG URL happily keeps
    // these characters (and `%3B`, which decodes to `;`) inside the host, so reject them here — at
    // the one registration-time gate — so no stored URI can ever carry a CSP-splitting character.
    it('rejects a literal semicolon in the host (CSP directive terminator)', () => {
      expect(() => validateRedirectUriFormat('https://a;b.com/cb', opts)).toThrow(
        InvalidRedirectUriError,
      );
    });

    it('rejects a literal comma in the host (CSP source-list separator)', () => {
      expect(() => validateRedirectUriFormat('https://a,b.com/cb', opts)).toThrow(
        InvalidRedirectUriError,
      );
    });

    it('rejects a percent-encoded semicolon (%3B) that decodes into the host', () => {
      // `new URL` decodes `%3B` back to `;` in the host, so this must be rejected like a literal `;`.
      expect(() => validateRedirectUriFormat('https://a%3Bb.com/cb', opts)).toThrow(
        InvalidRedirectUriError,
      );
    });

    it('still accepts hosts with no CSP-splitting characters (IPv6 literal, IDN punycode)', () => {
      // Positive lock: the host-character guard must not reject legitimate hosts. IPv6 literals carry
      // `:` inside brackets and punycode IDN hosts carry `-`; neither is `;` / `,` / whitespace.
      expect(() => validateRedirectUriFormat('https://[2001:db8::1]/cb', opts)).not.toThrow();
      expect(() =>
        validateRedirectUriFormat('https://xn--80akhbyknj4f.example/cb', opts),
      ).not.toThrow();
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
