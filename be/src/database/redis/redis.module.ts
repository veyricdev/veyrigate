import { Global, Logger, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import type { DatabaseConfig } from '../../config/configuration';
import { REDIS_CLIENT } from './redis.constants';
import { RedisService } from './redis.service';

/**
 * Redis (ioredis) connection module (B1.4).
 *
 * Provides a single shared client built from `database.redisUrl`. ioredis
 * retries with exponential backoff by default; `maxRetriesPerRequest: null`
 * keeps commands queued while reconnecting instead of failing fast, which suits
 * a long-lived shared client. Clean shutdown lives in `RedisService`.
 */
const redisClientProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): IORedis => {
    const logger = new Logger('RedisClient');
    const { redisUrl } = config.getOrThrow<DatabaseConfig>('database');
    const client = new IORedis(redisUrl, {
      lazyConnect: false,
      maxRetriesPerRequest: null,
      retryStrategy: (times) => Math.min(times * 200, 2000),
    });
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
