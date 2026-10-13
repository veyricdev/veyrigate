import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

/**
 * Parse `TRUST_PROXY` (DEBT-006) into a value accepted by Fastify's `trustProxy` option.
 *
 * `req.ip` (and the X-Forwarded-For chain) is the subject of the client-auth rate-limit buckets
 * (Task 2). Behind a reverse proxy, an UNconfigured app sees the proxy's socket IP for every
 * client, so the per-IP bucket becomes a GLOBAL limit and `clientId|ip` keys on the bare
 * `client_id` — an attacker could then lock out a legitimate client. So this defaults to DISABLED
 * and must be set to the real proxy IP(s) in production (see runbook-deploy §TRUST_PROXY).
 *
 * Accepted values:
 * - empty / unset / `false`  => `false` (do not trust any X-Forwarded-For; use the socket IP).
 * - a comma-separated list   => trust these IPs/CIDRs (each validated).
 *
 * A numeric HOP COUNT is REJECTED on purpose: Fastify 5 (`getTrustProxyFn`) silently maps a numeric
 * `trustProxy` to "trust nothing" (fail-closed) because it cannot authenticate the adjacent peer, so
 * accepting a number would look configured but leave `req.ip` on the proxy's socket IP — turning the
 * per-IP rate-limit bucket into a GLOBAL limit with no warning. Operators must instead list the real
 * IP/CIDR of the reverse proxy.
 *
 * `true` is REJECTED on purpose: trusting every X-Forwarded-For lets a client spoof its IP and
 * sail past the per-IP bucket. So are the SYNTACTICALLY-valid equivalents of "trust everything":
 * - a CIDR prefix below /8 (e.g. `0.0.0.0/0`, `::/0`) — too broad to be a real proxy network.
 * - an IPv4-mapped IPv6 range wider than /104 (e.g. `::ffff:0:0/96`, which proxy-addr treats as
 *   trusting EVERY IPv4). Each entry is PARSED with `ipaddr.js` (the same library proxy-addr
 *   uses) and classified on the normalized address, so equivalent spellings of a mapped range
 *   (`0:0:0:0:0:ffff:0:0/96`, `0::ffff:0.0.0.0/96`, …) cannot slip past a raw-text check.
 *
 * Minimum prefix is /8 because `10.0.0.0/8` and `fd00::/8` are common, legitimate proxy networks.
 */
const MIN_PREFIX = 8; // reject CIDRs broader than /8
const MIN_MAPPED_V4_PREFIX = 104; // ::ffff:0:0/96 == v4 /0; require >= /8 on the embedded v4

export function parseTrustProxy(raw: string | undefined): false | string[] {
  const value = (raw ?? '').trim();
  if (value === '' || value.toLowerCase() === 'false') {
    return false;
  }
  if (value.toLowerCase() === 'true') {
    throw new Error(
      'TRUST_PROXY=true is not allowed (it trusts every X-Forwarded-For, enabling IP spoofing past rate-limit buckets). Set the proxy IP(s)/CIDR(s) instead.',
    );
  }
  if (/^\d+$/.test(value)) {
    throw new Error(
      `TRUST_PROXY="${value}" is not allowed: Fastify 5 ignores a numeric (hop-count) trustProxy and silently trusts no proxy, leaving req.ip on the proxy socket IP (per-IP rate-limit bucket becomes a global limit). Set the reverse proxy's IP/CIDR instead (e.g. 10.0.0.0/8).`,
    );
  }
  const entries = value
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  if (entries.length === 0) {
    throw new Error(
      `TRUST_PROXY="${value}" has no IP/CIDR entries after trimming. Leave it empty/unset to disable, or set the reverse proxy's IP/CIDR(s).`,
    );
  }
  for (const entry of entries) {
    const reason = ipOrCidrRejection(entry);
    if (reason) {
      throw new Error(`TRUST_PROXY entry "${entry}" rejected: ${reason}`);
    }
  }
  return entries;
}

/**
 * Returns a human-readable reason to REJECT an `address`/`address/prefix` entry, or `null` when it
 * is an acceptable (narrow enough) IP/CIDR. Rejects broad-prefix CIDRs that are equivalent to
 * "trust everything" — see {@link parseTrustProxy}.
 */
function ipOrCidrRejection(entry: string): string | null {
  const slash = entry.indexOf('/');
  if (slash === -1) {
    return isIP(entry) !== 0 ? null : 'not a valid IP address';
  }
  // Reject non-standard IPv4 spellings in the address part BEFORE parseCIDR. `ipaddr.parseCIDR`
  // accepts octal/hex/shorthand forms (`010.0.0.0/8`, `0x7f.0.0.1/8`, `127.1/8`) and normalizes
  // them to a DIFFERENT address than the text suggests (`010.0.0.0` => `8.0.0.0`, a PUBLIC /8),
  // so proxy-addr would trust a public range the operator did not intend. Require the address to
  // be a canonical dotted-decimal IPv4 or a standard IPv6, matching the single-IP branch above.
  if (isIP(entry.slice(0, slash)) === 0) {
    return 'not a valid IP/CIDR';
  }
  // Classify on the PARSED address, not the raw text. IPv6 has many spellings for the same
  // address (`::ffff:0:0`, `0:0:0:0:0:ffff:0:0`, `0::ffff:0.0.0.0`, …), so a regex on the raw
  // string can be bypassed by an equivalent-but-differently-written value. We parse with the
  // SAME library proxy-addr uses (`ipaddr.js`), so our classification matches how `req.ip` is
  // actually resolved at runtime.
  let ip: ipaddr.IPv4 | ipaddr.IPv6;
  let bits: number;
  try {
    [ip, bits] = ipaddr.parseCIDR(entry);
  } catch {
    return 'not a valid IP/CIDR';
  }
  // IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is really an IPv4 range — proxy-addr trusts a matching
  // IPv4 client for it — so compare on the embedded v4 prefix regardless of how it was written.
  if (ip.kind() === 'ipv6' && (ip as ipaddr.IPv6).isIPv4MappedAddress()) {
    if (bits < MIN_MAPPED_V4_PREFIX) {
      return `IPv4-mapped prefix /${bits} trusts too many IPv4 addresses (min /${MIN_MAPPED_V4_PREFIX})`;
    }
    return null;
  }
  if (bits < MIN_PREFIX) {
    return `prefix /${bits} is too broad (min /${MIN_PREFIX})`;
  }
  return null;
}

/**
 * Guard against the two `parseTrustProxy` call-sites drifting apart. The Fastify adapter in
 * `main.ts` parses `TRUST_PROXY` directly (it must be set when the adapter is constructed, before
 * ConfigModule validates), while the typed config parses the SAME env later. If those disagree —
 * e.g. the adapter saw a stale `process.env` because `.env` had not been loaded yet — `req.ip`
 * would be resolved differently from what the rest of the app believes, silently weakening the
 * rate-limit buckets. This asserts the two agree and gives the otherwise-unused `app.trustProxy`
 * config a reader. Throws (fail-fast bootstrap) on a mismatch.
 */
export function assertTrustProxyConsistent(
  adapterValue: false | string[],
  configValue: false | string[],
): void {
  if (JSON.stringify(adapterValue) !== JSON.stringify(configValue)) {
    throw new Error(
      `TRUST_PROXY mismatch between the Fastify adapter (${JSON.stringify(adapterValue)}) and the typed config (${JSON.stringify(configValue)}). Ensure .env is loaded before bootstrap.`,
    );
  }
}
