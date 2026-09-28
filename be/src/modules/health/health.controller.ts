import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MongoService } from '../../database/mongo/mongo.service';
import { RedisService } from '../../database/redis/redis.service';

/**
 * Liveness and readiness probes (B1.3).
 *
 * - `GET /health` — liveness: always 200 while the process is up.
 * - `GET /ready`  — readiness: 200 only when both Mongo and Redis answer;
 *   503 (with per-dependency status) if either is down.
 */
@Controller()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  /**
   * Max time to wait for a dependency ping before treating it as down. Needed
   * because the shared ioredis client uses `maxRetriesPerRequest: null`, which
   * queues commands while reconnecting instead of failing fast — without this
   * bound `/ready` would hang until the client cancels instead of returning 503.
   */
  private static readonly PING_TIMEOUT_MS = 1500;

  constructor(
    private readonly mongo: MongoService,
    private readonly redis: RedisService,
  ) {}

  @Get('health')
  @HttpCode(HttpStatus.OK)
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async readiness(): Promise<{ status: 'ok'; mongo: 'up'; redis: 'up' }> {
    const [mongoUp, redisUp] = await Promise.all([this.safePing('mongo'), this.safePing('redis')]);
    if (!mongoUp || !redisUp) {
      throw new ServiceUnavailableException({
        status: 'error',
        mongo: mongoUp ? 'up' : 'down',
        redis: redisUp ? 'up' : 'down',
      });
    }
    return { status: 'ok', mongo: 'up', redis: 'up' };
  }

  private async safePing(dep: 'mongo' | 'redis'): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), HealthController.PING_TIMEOUT_MS);
    });
    try {
      const ping = dep === 'mongo' ? this.mongo.ping() : this.redis.ping();
      // If the timeout wins, `ping` stays pending (ioredis keeps it queued while
      // reconnecting); swallow its eventual rejection to avoid an unhandled one.
      ping.catch(() => undefined);
      return await Promise.race([ping, timeout]);
    } catch (err) {
      this.logger.warn(`${dep} readiness check failed: ${(err as Error).message}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
