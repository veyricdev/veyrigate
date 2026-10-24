import net from 'node:net';
import type { AddressInfo } from 'node:net';

/**
 * In-process TCP proxy in front of `vg-test-redis` (run 53c): lets a test take Redis "down" without
 * touching the shared container. Modes:
 * - `up`: forward both ways;
 * - `refuse`: destroy every connection and stop listening (connect ⇒ ECONNREFUSED);
 * - `blackhole`: destroy every connection, keep accepting new ones but never forward or answer
 *   (connect succeeds, every reply times out — a partition / stuck Redis);
 * - `stall`: keep the open connections but stop forwarding (the client stays `ready`, no reply).
 * `up()` after `refuse()` listens again on the SAME port, so the client reconnects by itself.
 */
export interface RedisProxy {
  readonly port: number;
  readonly url: string;
  up(): Promise<void>;
  refuse(): Promise<void>;
  blackhole(): void;
  stall(): void;
  close(): Promise<void>;
}

export async function startRedisProxy(
  target = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479',
): Promise<RedisProxy> {
  const { hostname, port: targetPort } = new URL(target);
  const sockets = new Set<net.Socket>();
  const pairs: Array<[net.Socket, net.Socket]> = [];
  let mode: 'up' | 'blackhole' = 'up';

  const track = (socket: net.Socket): void => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
  };
  const server = net.createServer((client) => {
    track(client);
    if (mode === 'blackhole') return; // accepted, never answered
    const upstream = net.connect(Number(targetPort) || 6379, hostname);
    track(upstream);
    pairs.push([client, upstream]);
    client.pipe(upstream);
    upstream.pipe(client);
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  });
  const listen = (port: number): Promise<void> =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  const dropAll = (): void => {
    for (const s of sockets) s.destroy();
  };

  await listen(0);
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `redis://127.0.0.1:${port}`,
    async up() {
      mode = 'up';
      dropAll(); // a client stuck on a blackholed socket reconnects through the forwarder
      if (!server.listening) await listen(port);
    },
    async refuse() {
      dropAll();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    blackhole() {
      mode = 'blackhole';
      dropAll();
    },
    stall() {
      for (const [client, upstream] of pairs) {
        client.unpipe(upstream);
        upstream.unpipe(client);
      }
    },
    async close() {
      dropAll();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
