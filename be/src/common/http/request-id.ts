import { randomUUID } from 'node:crypto';
import { BlockList, isIPv4, isIPv6 } from 'node:net';

/** A client `x-request-id` is kept only when it is a short safe token (DEBT-095, D90.10). */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * The `TRUST_PROXY` list (IPs / CIDRs, already validated by `parseTrustProxy`) as a `BlockList`
 * (run 91, DEBT-667 d, D91.10); undefined when nothing is trusted.
 */
export function trustedProxies(list: false | readonly string[] | undefined): BlockList | undefined {
  if (!list || list.length === 0) return undefined;
  const trusted = new BlockList();
  for (const entry of list) {
    const [address, prefix] = entry.split('/');
    const type = isIPv6(address) ? 'ipv6' : 'ipv4';
    if (prefix === undefined) trusted.addAddress(address, type);
    else trusted.addSubnet(address, Number(prefix), type);
  }
  return trusted;
}

/** Whether the socket peer is a trusted proxy; an IPv4-mapped IPv6 peer is also checked as IPv4. */
function fromTrustedProxy(trusted: BlockList | undefined, remote: string | undefined): boolean {
  if (!trusted || !remote) return false;
  const mapped = remote.toLowerCase().startsWith('::ffff:') ? remote.slice(7) : undefined;
  if (mapped && isIPv4(mapped) && trusted.check(mapped, 'ipv4')) return true;
  if (isIPv4(remote)) return trusted.check(remote, 'ipv4');
  return isIPv6(remote) && trusted.check(remote, 'ipv6');
}

/**
 * Fastify `genReqId` (DEBT-095): the ONE source of the request id. `req.id` is what pino-http logs
 * (it keeps an existing `req.id`) and what every audit `requestId` carries, and the adapter echoes it
 * in the `x-request-id` response header. A client `x-request-id` is used only when the socket peer
 * is a trusted proxy (`TRUST_PROXY`, D91.10; the proxy must overwrite the header) AND the value is a
 * safe token; anything else (no TRUST_PROXY, another peer, absent, empty, too long, CR/LF, a joined
 * duplicate, an array) gets a fresh UUID: never echoed, never logged.
 */
export function requestIdFrom(
  req: {
    headers: Record<string, string | string[] | undefined>;
    socket?: { remoteAddress?: string };
  },
  trusted?: BlockList,
): string {
  const value = req.headers['x-request-id'];
  return fromTrustedProxy(trusted, req.socket?.remoteAddress) &&
    typeof value === 'string' &&
    SAFE_REQUEST_ID.test(value)
    ? value
    : randomUUID();
}
