import ipaddr from 'ipaddr.js';

/** Longest IPv6 text (45) plus a short zone id; anything longer is not an address we stored. */
const MAX_IP_LENGTH = 64;

/**
 * Audit IP as shown to an admin without `super_admin` (run 71, DEBT-344, plan §12): the network
 * prefix only, IPv4 `/24`, IPv6 `/48` (an IPv4-mapped IPv6 is unmapped first, so it never leaks the
 * full IPv4; a 6to4 address is reduced to its embedded IPv4 the same way). Only a plain four-part decimal IPv4 or a valid IPv6 is accepted; anything else
 * (empty, `127.1`, hex, CIDR, garbage) => `undefined` (fail-closed: the stored string is NEVER
 * returned).
 */
export function maskIp(ip: string | undefined): string | undefined {
  if (!ip || ip.length > MAX_IP_LENGTH) return undefined;
  if (ipaddr.IPv4.isValidFourPartDecimal(ip)) return v4Prefix(ipaddr.IPv4.parse(ip));
  if (!ipaddr.IPv6.isValid(ip)) return undefined;
  const v6 = ipaddr.IPv6.parse(ip);
  if (v6.isIPv4MappedAddress()) return v4Prefix(v6.toIPv4Address());
  // DEBT-498: 6to4 (2002::/16) embeds the full IPv4 in hextets 2-3, which a /48 would keep.
  if (v6.range() === '6to4') {
    const [, hi, lo] = v6.parts;
    return v4Prefix(new ipaddr.IPv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]));
  }
  // A fresh address from the first 3 hextets: drops the rest and any zone id (`%eth0`).
  return `${new ipaddr.IPv6([...v6.parts.slice(0, 3), 0, 0, 0, 0, 0]).toString()}/48`;
}

function v4Prefix(v4: ipaddr.IPv4): string {
  const [a, b, c] = v4.octets;
  return `${a}.${b}.${c}.0/24`;
}
