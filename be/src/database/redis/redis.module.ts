import { Global, Logger, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis, { type RedisOptions } from 'ioredis';
import type { AppConfig, DatabaseConfig } from '../../config/configuration';
import { REDIS_CLIENT } from './redis.constants';
import { RedisService } from './redis.service';
import { scrubUriCredentials } from '../../common/logger/error-log';

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
 * - Sentinel mode (run 53c, `REDIS_SENTINELS`): the same bounds plus the sentinel list, master name,
 *   credentials and db; ioredis asks a sentinel for the current master on every (re)connect.
 *   Redis Cluster is not supported (DEBT-013/073).
 *
 * Extracted as a pure function so the exact options can be asserted in a unit/integration test.
 */
export function buildRedisOptions(config: DatabaseConfig): RedisOptions {
  const common: RedisOptions = {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    commandTimeout: config.redisCommandTimeoutMs,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  };
  const s = config.redisSentinel;
  if (!s) return common;
  return {
    ...common,
    sentinels: s.sentinels,
    name: s.masterName,
    sentinelPassword: s.sentinelPassword,
    username: s.username,
    password: s.password,
    db: s.db,
  };
}

/** Plan §6.2: production runs Redis Sentinel. Standalone still boots (not blocked), but says so. */
export function standaloneInProductionWarning(
  app: AppConfig,
  database: DatabaseConfig,
): string | undefined {
  return app.nodeEnv === 'production' && !database.redisSentinel
    ? 'Redis standalone (REDIS_URL) in production: no failover; use REDIS_SENTINELS (plan §6.2)'
    : undefined;
}

/**
 * Redis (ioredis) connection module (B1.4).
 *
 * Provides a single shared client built from `database.redisUrl` or `database.redisSentinel` with the options from
 * `buildRedisOptions` (fail-fast `commandTimeout`, see DEBT-005). Clean shutdown lives in
 * `RedisService`.
 */
const redisClientProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): IORedis => {
    const logger = new Logger('RedisClient');
    const database = config.getOrThrow<DatabaseConfig>('database');
    const warning = standaloneInProductionWarning(config.getOrThrow<AppConfig>('app'), database);
    if (warning) logger.warn(warning);
    const options = buildRedisOptions(database);
    const client = database.redisUrl
      ? new IORedis(database.redisUrl, options)
      : new IORedis(options);
    client.on('error', (err) => logger.error(`Redis error: ${scrubUriCredentials(err.message)}`));
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
