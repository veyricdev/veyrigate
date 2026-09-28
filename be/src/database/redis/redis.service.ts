import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

/**
 * Thin wrapper around the shared ioredis client (B1.4).
 *
 * Exposes the raw client for data access and a `ping()` used by the readiness
 * probe. Closes the connection cleanly on shutdown.
 */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Raw ioredis client (custom Lua commands attached in B4.3/B4.5). */
  get client(): Redis {
    return this.redis;
  }

  /** Returns true when Redis answers PONG. Used by `/ready`. */
  async ping(): Promise<boolean> {
    const reply = await this.redis.ping();
    return reply === 'PONG';
  }

  async onApplicationShutdown(): Promise<void> {
    this.logger.log('Closing Redis connection');
    await this.redis.quit();
  }
}
