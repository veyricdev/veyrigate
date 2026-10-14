import { buildCsp, safeCspOrigin } from './csp';

/**
 * The global helmet CSP header value (helmet 8, `main.ts` directives). `buildCsp()` with no options
 * MUST equal this byte-for-byte (acceptance #8 cross-checks it against a live app response too).
 */
const GLOBAL_CSP =
  "default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';" +
  "frame-ancestors 'none';img-src 'self' data:;object-src 'none';script-src 'self';" +
  "script-src-attr 'none';style-src 'self';upgrade-insecure-requests";

const directives = (csp: string): Map<string, string> => {
  const map = new Map<string, string>();
  for (const part of csp.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(' ');
    if (idx === -1) map.set(trimmed, '');
    else map.set(trimmed.slice(0, idx), trimmed.slice(idx + 1));
  }
  return map;
};

describe('buildCsp', () => {
  it('with no options is byte-identical to the global helmet CSP', () => {
    expect(buildCsp()).toBe(GLOBAL_CSP);
    expect(buildCsp({})).toBe(GLOBAL_CSP);
    expect(buildCsp({ formAction: [], frameSrc: [] })).toBe(GLOBAL_CSP);
  });

  it("appends extra form-action origins after 'self' and leaves every other directive unchanged", () => {
    const csp = buildCsp({ formAction: ['https://rp.example'] });
    const d = directives(csp);
    expect(d.get('form-action')).toBe("'self' https://rp.example");
    const global = directives(GLOBAL_CSP);
    for (const [name, value] of global) {
      if (name === 'form-action') continue;
      expect(d.get(name)).toBe(value);
    }
    // No new directives beyond the global set.
    expect([...d.keys()].sort()).toEqual([...global.keys()].sort());
  });

  it('adds frame-src only when provided, next to frame-ancestors, without weakening others', () => {
    const csp = buildCsp({ frameSrc: ['https://rp1.example', 'https://rp2.example'] });
    const d = directives(csp);
    expect(d.get('frame-src')).toBe('https://rp1.example https://rp2.example');
    expect(d.get('form-action')).toBe("'self'");
    expect(csp).toContain("frame-ancestors 'none';frame-src https://rp1.example");
  });

  it('dedupes repeated sources', () => {
    expect(
      directives(buildCsp({ formAction: ['https://rp.example', 'https://rp.example'] })).get(
        'form-action',
      ),
    ).toBe("'self' https://rp.example");
    expect(
      directives(buildCsp({ frameSrc: ['https://a.example', 'https://a.example'] })).get(
        'frame-src',
      ),
    ).toBe('https://a.example');
  });
});

describe('safeCspOrigin', () => {
  it('returns the bare origin for a valid https/http URI (no path/query)', () => {
    expect(safeCspOrigin('https://rp.example/callback?x=1')).toBe('https://rp.example');
    expect(safeCspOrigin('http://localhost:5173/callback')).toBe('http://localhost:5173');
    expect(safeCspOrigin('https://rp.example:8443/cb')).toBe('https://rp.example:8443');
  });

  it('returns null for parse errors, opaque, non-http(s), or header-splitting input', () => {
    expect(safeCspOrigin(undefined)).toBeNull();
    expect(safeCspOrigin(null)).toBeNull();
    expect(safeCspOrigin('')).toBeNull();
    expect(safeCspOrigin('not a url')).toBeNull();
    expect(safeCspOrigin('javascript:alert(1)')).toBeNull();
    expect(safeCspOrigin('data:text/html,x')).toBeNull();
    expect(safeCspOrigin('urn:example:1')).toBeNull();
    expect(safeCspOrigin('file:///etc/passwd')).toBeNull();
  });

  it('rejects a host that could split the header (semicolon/comma/whitespace/control)', () => {
    // These never survive the registration validator (INV-084-1), this is the second layer.
    expect(safeCspOrigin('https://evil.example;script-src *')).toBeNull();
    expect(safeCspOrigin('https://evil.example,https://also.evil')).toBeNull();
    expect(safeCspOrigin('https://evil.example x')).toBeNull();
  });
});
