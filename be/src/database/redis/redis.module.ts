import { Global, Logger, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis, { type RedisOptions } from 'ioredis';
import type { DatabaseConfig } from '../../config/configuration';
import { REDIS_CLIENT } from './redis.constants';
import { RedisService } from './redis.service';

/**
 * Redis (ioredis) connection options for the single shared client (B1.4, DEBT-005).
 *
 * - `commandTimeout` (`database.redisCommandTimeoutMs`, env `REDIS_COMMAND_TIMEOUT_MS`, default
 *   1000ms) bounds every request-path command (rate-limit, session liveness, tombstone) so a down
 *   or reconnecting Redis fails fast instead of hanging. Security checks that depend on Redis then
 *   fail closed (reject) rather than fail open.
 * - `maxRetriesPerRequest: 1` (NOT `null`): `commandTimeout` only rejects the caller's promise —
 *   the command stays in the offline queue and would be REPLAYED on reconnect. With `null` a long
 *   outage grows that queue without bound and replays stale writes (session create, rate-limit
 *   INCR) on recovery. `1` lets ioredis flush the queue with `MaxRetriesPerRequestError`.
 * - `enableOfflineQueue` stays default (true) so a short boot/blip does not break the first command.
 *
 * Extracted as a pure function so the exact options can be asserted in a unit/integration test.
 */
export function buildRedisOptions(config: DatabaseConfig): RedisOptions {
  return {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    commandTimeout: config.redisCommandTimeoutMs,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  };
}

/**
 * Redis (ioredis) connection module (B1.4).
 *
 * Provides a single shared client built from `database.redisUrl` with the options from
 * `buildRedisOptions` (fail-fast `commandTimeout`, see DEBT-005). Clean shutdown lives in
 * `RedisService`.
 */
const redisClientProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): IORedis => {
    const logger = new Logger('RedisClient');
    const database = config.getOrThrow<DatabaseConfig>('database');
    const client = new IORedis(database.redisUrl, buildRedisOptions(database));
    client.on('error', (err) => logger.error(`Redis error: ${err.message}`));
    client.on('connect', () => logger.log('Redis connected'));
    return client;
  },
};

@Global()
@Module({
  providers: [redisClientProvider, RedisService],
  exports: [REDIS_CLIENT, RedisService],
})
export class RedisModule {}
