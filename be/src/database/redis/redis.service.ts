import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

const QUIT_TIMEOUT_MS = 1000;

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

  /**
   * DEBT-397: bounded shutdown. Graceful `QUIT` only when connected, capped at 1 s; then always
   * `disconnect()`. With Redis down, `quit()` is queued behind leftover commands (e.g. the `/ready`
   * PING), fails, and the client kept reconnecting: the process never exited (`docker stop` ⇒ 137).
   */
  async onApplicationShutdown(): Promise<void> {
    this.logger.log('Closing Redis connection');
    if (this.redis.status === 'ready') {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        this.redis.quit().catch(() => undefined),
        new Promise((resolve) => (timer = setTimeout(resolve, QUIT_TIMEOUT_MS))),
      ]);
      clearTimeout(timer);
    }
    this.redis.disconnect();
  }
}
