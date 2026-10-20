import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { collectDefaultMetrics } from '@prometheus-io/client';
import { httpDuration, registry } from './metrics';

/** The app's Fastify instance (`fastify` itself is not a direct dependency of `be`). */
type FastifyInstance = ReturnType<
  ReturnType<NestFastifyApplication['getHttpAdapter']>['getInstance']
>;

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const logger = new Logger('Metrics');
let defaultMetricsStarted = false;

const sha256 = (v: string) => createHash('sha256').update(v).digest();

/**
 * B7.2 HTTP wiring, shared by `configureApp` and the integration test (same code under test):
 * - `onResponse` hook: request latency by method (fixed set, else OTHER), route TEMPLATE
 *   (`__unmatched` when no route matched; never the raw URL) and status class;
 * - `GET /metrics` (text exposition), registered ONLY when `token` is set (unset => 404). Access
 *   needs `Authorization: Bearer <token>` (timing-safe compare of SHA-256 digests); anything else,
 *   including a token in the query string, is 401 with an empty body.
 * Must run before Nest registers its routes so they all get the hook.
 */
export function registerMetrics(fastify: FastifyInstance, opts: { token?: string }): void {
  if (!defaultMetricsStarted) {
    defaultMetricsStarted = true;
    collectDefaultMetrics({ register: registry });
  }

  fastify.addHook('onResponse', async (request, reply) => {
    httpDuration.observe(
      {
        method: METHODS.has(request.method) ? request.method : 'OTHER',
        route: request.routeOptions.url ?? '__unmatched',
        status_class: `${Math.floor(reply.statusCode / 100)}xx`,
      },
      reply.elapsedTime / 1000,
    );
  });

  if (!opts.token) return;
  const expected = sha256(opts.token);

  fastify.get('/metrics', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const auth = request.headers['authorization'];
    const match = typeof auth === 'string' ? /^Bearer (\S+)$/i.exec(auth) : null;
    if (!match || !timingSafeEqual(sha256(match[1]), expected)) {
      return reply.code(401).header('WWW-Authenticate', 'Bearer').send();
    }
    let body: string;
    try {
      body = await registry.metrics();
    } catch (err) {
      logger.error(`metrics collection failed: ${(err as Error).message}`);
      return reply.code(500).send();
    }
    return reply.code(200).header('Content-Type', registry.contentType).send(body);
  });
}
