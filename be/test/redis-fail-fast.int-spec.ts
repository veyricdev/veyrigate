import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import { buildRedisOptions } from '../src/database/redis/redis.module';
import { RedisService } from '../src/database/redis/redis.service';
import type { DatabaseConfig } from '../src/config/configuration';
import { RateLimitService } from '../src/modules/security/rate-limit/rate-limit.service';

/**
 * DEBT-005: with `buildRedisOptions` (commandTimeout + maxRetriesPerRequest:1) a command against an
 * unreachable Redis FAILS FAST instead of queuing forever. Security checks that depend on Redis then
 * fail closed (reject) rather than silently fail open. We point at `127.0.0.1:1` (nothing listens)
 * so no live container is needed. Eventual rejections are swallowed and clients disconnected.
 */
const DEAD_URL = 'redis://127.0.0.1:1';
const COMMAND_TIMEOUT_MS = 1000;

const dbConfig: DatabaseConfig = {
  mongoUri: 'mongodb://unused',
  redisUrl: DEAD_URL,
  redisCommandTimeoutMs: COMMAND_TIMEOUT_MS,
};

/** Resolve with 'pending' if `p` has not settled within `ms` (so a hang is observable, not fatal). */
const settledWithin = async (
  p: Promise<unknown>,
  ms: number,
): Promise<'resolved' | 'rejected' | 'pending'> => {
  p.catch(() => undefined); // never let the eventual rejection go unhandled
  let timer: NodeJS.Timeout | undefined;
  const race = await Promise.race([
    p.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    ),
    new Promise<'pending'>((resolve) => {
      timer = setTimeout(() => resolve('pending'), ms);
    }),
  ]);
  clearTimeout(timer);
  return race;
};

describe('Redis request-path fail-fast on an unreachable server (DEBT-005)', () => {
  it('RED: the OLD options (maxRetriesPerRequest:null, no commandTimeout) stay pending past 2.5s', async () => {
    const client = new IORedis(DEAD_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: null,
      retryStrategy: (times) => Math.min(times * 200, 2000),
    });
    try {
      const outcome = await settledWithin(client.get('k'), 2500);
      expect(outcome).toBe('pending'); // queued forever — the bug this task fixes
    } finally {
      client.disconnect();
    }
  }, 10_000);

  it('GREEN: buildRedisOptions rejects a command within ~commandTimeout (no hang)', async () => {
    const client = new IORedis(DEAD_URL, buildRedisOptions(dbConfig));
    try {
      const start = Date.now();
      await expect(client.get('k')).rejects.toBeInstanceOf(Error);
      expect(Date.now() - start).toBeLessThanOrEqual(COMMAND_TIMEOUT_MS + 500);
    } finally {
      client.disconnect();
    }
  }, 10_000);

  it('buildRedisOptions sets commandTimeout from config and maxRetriesPerRequest=1', () => {
    const opts = buildRedisOptions(dbConfig);
    expect(opts.commandTimeout).toBe(COMMAND_TIMEOUT_MS);
    expect(opts.maxRetriesPerRequest).toBe(1);
    expect(opts.lazyConnect).toBe(false);
  });

  it('fail-closed: RateLimitService.hit REJECTS (never returns allowed:true) when Redis is unreachable', async () => {
    const client = new IORedis(DEAD_URL, buildRedisOptions(dbConfig));
    const config = {
      getOrThrow: () => ({ rateLimitMax: 5, rateLimitWindow: 60 }),
    } as unknown as ConfigService;
    const service = new RateLimitService(new RedisService(client), config);
    try {
      const start = Date.now();
      await expect(
        service.hit(
          { name: 'debt005-login', limit: 3, windowSec: 30 },
          { account: 'a@example.com' },
        ),
      ).rejects.toBeInstanceOf(Error);
      expect(Date.now() - start).toBeLessThanOrEqual(COMMAND_TIMEOUT_MS + 1000);
    } finally {
      client.disconnect();
    }
  }, 10_000);

  /**
   * DEBT-066: the `127.0.0.1:1` cases above only prove fail-fast for a REFUSED connection, where
   * `maxRetriesPerRequest:1` alone flushes the queue — so dropping `commandTimeout` would still pass
   * them. The dangerous, real-world scenario is a server that ACCEPTS the TCP connection but never
   * replies (blackhole / network partition / stuck Redis). There `maxRetriesPerRequest` never fires
   * (the command was written to the wire and is waiting for a reply), so ONLY `commandTimeout` cuts
   * the hang. This case therefore FAILS if `commandTimeout` is removed from `buildRedisOptions`.
   *
   * We stand up a local TCP server that accepts sockets and stays silent. `enableReadyCheck:false`
   * lets the connection go "ready" without an INFO round-trip, so the `GET` reaches the wire and is
   * the command that `commandTimeout` must bound. All sockets and the server are closed in `finally`
   * so no handle leaks past the test.
   */
  it('GREEN(DEBT-066): a silent (accepts-but-never-replies) server => `get` rejects with "Command timed out" within ~commandTimeout', async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => sockets.delete(socket));
      // Intentionally never write a reply: this is the blackhole.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const client = new IORedis({
      host: '127.0.0.1',
      port,
      ...buildRedisOptions(dbConfig),
      // Reach "ready" without an INFO round-trip so the GET is actually written to the wire and is
      // the in-flight command that `commandTimeout` governs (the whole point of DEBT-066).
      enableReadyCheck: false,
    });
    try {
      const start = Date.now();
      await expect(client.get('k')).rejects.toThrow(/Command timed out/i);
      const elapsed = Date.now() - start;
      // Fail-fast: bounded by commandTimeout, NOT the socket/test timeout. If `commandTimeout` were
      // dropped from buildRedisOptions the command would hang here and this assertion would fail.
      expect(elapsed).toBeGreaterThanOrEqual(COMMAND_TIMEOUT_MS - 200);
      expect(elapsed).toBeLessThanOrEqual(COMMAND_TIMEOUT_MS + 500);
    } finally {
      client.disconnect();
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);
});
