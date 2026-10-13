import { FastifyAdapter } from '@nestjs/platform-fastify';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { assertTrustProxyConsistent, parseTrustProxy } from './trust-proxy';

// Resolve the SAME `@fastify/proxy-addr` the FastifyAdapter uses at runtime (it is a transitive dep
// of `fastify`). Using the real library — instead of a hand-written mirror of its trust rules —
// means this spec can never silently drift from runtime when Fastify/proxy-addr is upgraded.
// `createRequire` is seeded from a path under the package root (works in both CJS and ESM, no
// `import.meta` so `tsc --noEmit` under module:commonjs stays happy).
const require_ = createRequire(join(process.cwd(), 'noop.cjs'));
// fastify is a transitive dep of the direct `@nestjs/platform-fastify`; chain the resolution so we
// land on the EXACT fastify (and its bundled @fastify/proxy-addr) the adapter loads at runtime.
const nestFastifyEntry = require_.resolve('@nestjs/platform-fastify');
const fastifyEntry = require_.resolve('fastify', { paths: [nestFastifyEntry] });
const proxyAddrPath = require_.resolve('@fastify/proxy-addr', { paths: [fastifyEntry] });
const proxyAddr = require_(proxyAddrPath) as {
  compile(val: string | string[]): (addr: string, i: number) => boolean;
};

describe('parseTrustProxy (DEBT-006)', () => {
  it('empty / undefined / whitespace => false (disabled by default)', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('   ')).toBe(false);
  });

  it('"false" (any case) => false', () => {
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('False')).toBe(false);
  });

  it('rejects a numeric (hop-count) value: Fastify 5 silently trusts no proxy for a number', () => {
    // fastify@5 getTrustProxyFn maps a numeric trustProxy to "trust nothing" (fail-closed), so a
    // hop count would look configured but leave req.ip on the proxy socket IP. Reject at parse.
    for (const n of ['1', '2', '0', '00', '10', '11']) {
      expect(() => parseTrustProxy(n)).toThrow(/TRUST_PROXY/);
    }
  });

  it('comma-separated IP/CIDR list => string[]', () => {
    expect(parseTrustProxy('10.0.0.1,10.0.0.0/8')).toEqual(['10.0.0.1', '10.0.0.0/8']);
    expect(parseTrustProxy('127.0.0.1')).toEqual(['127.0.0.1']);
    expect(parseTrustProxy('::1, 2001:db8::/32')).toEqual(['::1', '2001:db8::/32']);
  });

  it('rejects true (would trust every X-Forwarded-For => IP spoofing past the bucket)', () => {
    expect(() => parseTrustProxy('true')).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxy('True')).toThrow(/TRUST_PROXY/);
  });

  it('rejects an invalid IP/CIDR element', () => {
    expect(() => parseTrustProxy('10.0.0.1,not-an-ip')).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxy('10.0.0.0/999')).toThrow(/TRUST_PROXY/);
  });

  it('rejects an empty list (only separators/whitespace) => throw (looks on but trusts nothing)', () => {
    for (const empty of [',', ' , ', ',,', '  ']) {
      // '  ' trims to '' which disables (false); the comma-only ones have no entries after split.
      if (empty.trim() === '') {
        expect(parseTrustProxy(empty)).toBe(false);
      } else {
        expect(() => parseTrustProxy(empty)).toThrow(/TRUST_PROXY/);
      }
    }
  });

  // Regression (senior lượt 3 🟡1): the single-IP branch uses net.isIP (canonical dotted-decimal),
  // but the CIDR branch used to hand the whole entry to ipaddr.parseCIDR, which ACCEPTS octal/hex/
  // shorthand IPv4 and normalizes to a DIFFERENT address (010.0.0.0 => 8.0.0.0, a PUBLIC /8). An
  // operator typing a zero-padded "10/8" would then silently trust a public /8. Both branches must
  // reject non-standard spellings consistently.
  it('rejects non-standard IPv4 spellings in a CIDR (octal/hex/shorthand)', () => {
    for (const weird of ['010.0.0.0/8', '0x7f.0.0.1/8', '127.1/8', '0177.0.0.1/8']) {
      expect(() => parseTrustProxy(weird)).toThrow(/TRUST_PROXY/);
    }
  });

  it('rejects CIDR prefixes broader than /8 (≈ trust every IP)', () => {
    for (const broad of ['0.0.0.0/0', '0.0.0.0/7', '128.0.0.0/1', '::/0', '::/7', '2000::/3']) {
      expect(() => parseTrustProxy(broad)).toThrow(/TRUST_PROXY/);
    }
  });

  it('allows /8 (common internal proxy networks)', () => {
    expect(parseTrustProxy('10.0.0.0/8')).toEqual(['10.0.0.0/8']);
    expect(parseTrustProxy('fd00::/8')).toEqual(['fd00::/8']);
  });

  it('rejects IPv4-mapped IPv6 ranges wider than /104 (proxy-addr trusts every IPv4)', () => {
    for (const mapped of ['::ffff:0:0/96', '::ffff:0.0.0.0/96', '::ffff:0.0.0.0/103']) {
      expect(() => parseTrustProxy(mapped)).toThrow(/TRUST_PROXY/);
    }
    // /104 == the embedded v4 /8 — the narrowest accepted mapped range.
    expect(parseTrustProxy('::ffff:10.0.0.0/104')).toEqual(['::ffff:10.0.0.0/104']);
  });

  // Regression (senior lượt 2 🔴): a regex on the raw string only matched the `::ffff:` spelling,
  // so these equivalent IPv4-mapped /96 ranges slipped past the guard and made proxy-addr trust
  // EVERY IPv4 (client spoofs X-Forwarded-For → new rate-limit bucket per request).
  it('rejects IPv4-mapped /96 ranges written in equivalent IPv6 forms (not just "::ffff:")', () => {
    for (const mapped of [
      '0:0:0:0:0:ffff:0:0/96',
      '::0:ffff:0:0/96',
      '0::ffff:0.0.0.0/96',
      '0:0:0:0:0:FFFF:0.0.0.0/96',
    ]) {
      expect(() => parseTrustProxy(mapped)).toThrow(/TRUST_PROXY/);
    }
  });

  it('accepts a mapped /104 range written in long IPv6 form (0:0:0:0:0:ffff:a00:0/104)', () => {
    // `a00:0` == `10.0.0.0`; /104 is the narrowest accepted mapped range regardless of spelling.
    expect(parseTrustProxy('0:0:0:0:0:ffff:a00:0/104')).toEqual(['0:0:0:0:0:ffff:a00:0/104']);
  });

  const ACCEPTED = [
    '10.0.0.1',
    '10.0.0.0/8',
    '127.0.0.1',
    '::1',
    '2001:db8::/32',
    'fd00::/8',
    '::ffff:10.0.0.0/104',
    '0:0:0:0:0:ffff:a00:0/104',
  ];

  // Cross-check against the runtime trust decision using the REAL `@fastify/proxy-addr` (resolved
  // via fastify above): for EVERY entry parseTrustProxy accepts, a public IP must NOT be trusted.
  // An accepted entry can therefore never make the app trust a spoofable public client.
  it('never accepts an IP/CIDR that would trust a public IP (proxy-addr.compile)', () => {
    const PUBLIC_V4 = '203.0.113.9';
    const PUBLIC_V6 = '2001:4860:4860::8888';
    for (const entry of ACCEPTED) {
      // sanity: the entry really is accepted by our parser
      expect(parseTrustProxy(entry)).toEqual([entry]);
      const trusts = proxyAddr.compile([entry]);
      expect(trusts(PUBLIC_V4, 0)).toBe(false);
      expect(trusts(PUBLIC_V6, 0)).toBe(false);
    }
  });
});

/**
 * 🟡2: run the accepted IP/CIDR list through a REAL FastifyAdapter and resolve `req.ip` from an
 * injected request's X-Forwarded-For chain. This exercises the exact runtime path
 * (parseTrustProxy -> FastifyAdapter -> @fastify/proxy-addr) rather than any re-implementation, so
 * the test would also catch a numeric value being silently ignored (the lượt-3 🔴 regression).
 */
describe('parseTrustProxy through a real FastifyAdapter (DEBT-006, runtime req.ip)', () => {
  async function resolveReqIp(trustProxyEnv: string, xff: string): Promise<string> {
    const adapter = new FastifyAdapter({ trustProxy: parseTrustProxy(trustProxyEnv) });
    const fastify = adapter.getInstance();
    fastify.get('/ip', (req, reply) => {
      reply.send({ ip: req.ip });
    });
    await fastify.ready();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: '/ip',
        headers: { 'x-forwarded-for': xff },
      });
      return (JSON.parse(res.payload) as { ip: string }).ip;
    } finally {
      await fastify.close();
    }
  }

  it('trusts the proxy socket IP (127.0.0.1) and reads the real client from X-Forwarded-For', async () => {
    // inject() sends from 127.0.0.1; trusting only that one hop means req.ip is the RIGHT-most XFF
    // entry (the address the trusted proxy saw), i.e. 198.51.100.7 — not the socket IP, not the
    // further-left 203.0.113.9 (which would require the next hop to be trusted too).
    const ip = await resolveReqIp('127.0.0.1', '203.0.113.9, 198.51.100.7');
    expect(ip).toBe('198.51.100.7');
  });

  it('with a /8 proxy CIDR, a request from the loopback socket does NOT trust XFF', async () => {
    // inject's socket is 127.0.0.1, which is NOT inside 10.0.0.0/8, so XFF is ignored (fail-closed).
    const ip = await resolveReqIp('10.0.0.0/8', '203.0.113.9');
    expect(ip).toBe('127.0.0.1');
  });

  it('disabled (false) ignores X-Forwarded-For entirely (socket IP)', async () => {
    const ip = await resolveReqIp('', '203.0.113.9');
    expect(ip).toBe('127.0.0.1');
  });

  // Mutation guard (lượt-3 🔴): if numeric hop counts were accepted again, the adapter would be
  // built with a number that Fastify 5 SILENTLY ignores — req.ip would fall back to the socket IP
  // with no error. By rejecting the number at parse, building the adapter throws instead of
  // quietly degrading. This test fails if numeric support is restored.
  it('refuses to build a FastifyAdapter from a numeric hop count (never silently ignored)', async () => {
    await expect(resolveReqIp('1', '203.0.113.9')).rejects.toThrow(/TRUST_PROXY/);
  });
});

describe('assertTrustProxyConsistent (DEBT-006, fail-fast on adapter/config drift)', () => {
  it('does not throw when both call-sites agree', () => {
    expect(() => assertTrustProxyConsistent(false, false)).not.toThrow();
    expect(() => assertTrustProxyConsistent(['10.0.0.0/8'], ['10.0.0.0/8'])).not.toThrow();
  });

  it('throws when the adapter and the typed config disagree (stale .env)', () => {
    expect(() => assertTrustProxyConsistent(false, ['10.0.0.0/8'])).toThrow(/TRUST_PROXY mismatch/);
    expect(() => assertTrustProxyConsistent(['10.0.0.0/8'], ['10.0.0.1'])).toThrow(
      /TRUST_PROXY mismatch/,
    );
  });
});
