import { Controller, Get, HttpCode, HttpStatus, Logger, Res } from '@nestjs/common';
import { MongoService } from '../../database/mongo/mongo.service';
import { RedisService } from '../../database/redis/redis.service';

/** Minimal structural view of the Fastify reply `/ready` needs (status + header). */
interface HealthReply {
  status(code: number): HealthReply;
  header(name: string, value: string): HealthReply;
}

/** Per-dependency readiness status — a fixed enum, never a message/host/stack (exposure budget). */
type ReadinessBody =
  | { status: 'ok'; mongo: 'up'; redis: 'up' }
  | { status: 'error'; mongo: 'up' | 'down'; redis: 'up' | 'down' };

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
   * Max time to wait for a dependency ping before treating it as down. The shared ioredis client
   * now sets `commandTimeout` (DEBT-005), but that default (1000ms) is below this bound, so this
   * `Promise.race` still decides `/ready`'s own timeout independently of the client's and never
   * reports a slow dependency as up.
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
  async readiness(@Res({ passthrough: true }) reply: HealthReply): Promise<ReadinessBody> {
    // DEBT-001: return the 503 + per-dependency body DIRECTLY instead of throwing. The global
    // `OAuthExceptionFilter` maps every exception by status, so a thrown 503 would be rewritten to
    // `{error:'server_error'}` and the `mongo`/`redis` detail would be lost. Returning here keeps
    // the OAuth filter untouched for every other route. The body is a fixed enum (`up`/`down`) with
    // no message/host/stack (the only exposure is dependency up/down, per spec health); failure
    // detail stays in the server log (`safePing`'s `logger.warn`). `no-store` so a probe result is
    // never cached by an intermediary.
    reply.header('Cache-Control', 'no-store');
    const [mongoUp, redisUp] = await Promise.all([this.safePing('mongo'), this.safePing('redis')]);
    if (!mongoUp || !redisUp) {
      reply.status(HttpStatus.SERVICE_UNAVAILABLE);
      return {
        status: 'error',
        mongo: mongoUp ? 'up' : 'down',
        redis: redisUp ? 'up' : 'down',
      };
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
