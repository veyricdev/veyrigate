import { Module, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import type { AppConfig } from '../../config/configuration';

/**
 * Structured logging with nestjs-pino (B1.3, INV-20).
 *
 * Redacts sensitive fields so credentials/tokens never reach the logs, and
 * surfaces the request id (`req.id`) on every HTTP log line so access logs stay
 * correlatable with audit entries. That id has ONE source (DEBT-095): the Fastify
 * adapter's `genReqId` (`common/http/request-id`); pino-http keeps an existing
 * `req.id`, so no generator is configured here. In development the output
 * is pretty-printed; in production it stays as JSON.
 */

/**
 * Redaction paths cover both request/response bodies and headers. A wildcard
 * (`*`) matches exactly ONE level (fast-redact): `*.password` catches
 * `{ x: { password } }` but not `{ a: { b: { password } } }`, so a deeper
 * sensitive field needs its own path. `remove: true` drops the field entirely
 * rather than replacing it with `[Redacted]`. Message/stack TEXT is never seen
 * by redaction: scrub it with `common/logger/error-log` before logging.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.access_token',
  '*.refresh_token',
  '*.id_token',
  '*.code',
  '*.authorization_code',
  '*.secret',
  '*.client_secret',
  '*.cookie',
  '*.authorization',
  'password',
  'token',
  'code',
  'secret',
  'cookie',
  'authorization',
];

export function serializeRequest(req: { id?: unknown; method?: string; url?: string }): {
  id?: unknown;
  method?: string;
  url?: string;
} {
  // `id` is the non-secret request id (`common/http/request-id`; correlates access log <-> audit).
  return { id: req.id, method: req.method, url: req.url?.split('?', 1)[0] };
}

/**
 * Allow-list response serializer (DEBT-089, INV-20): return only `statusCode` +
 * an optional scrubbed `location`, so no other header (`set-cookie`…) is logged.
 * `location` is cut with `split(/[?#]/)` (not `new URL`, which throws on relative
 * locations) to drop the query (authz `code`/`state` on a 302) and fragment;
 * non-string/missing `location` fails closed (key omitted).
 */
export function serializeResponse(res: {
  statusCode?: number;
  headers?: Record<string, unknown>;
}): {
  statusCode?: number;
  headers: { location?: string };
} {
  const headers: { location?: string } = {};
  const location = res.headers?.location;
  if (typeof location === 'string') {
    headers.location = location.split(/[?#]/, 1)[0];
  }
  return { statusCode: res.statusCode, headers };
}

/**
 * Builds the `pinoHttp` options shared by every environment. Exported so the
 * logger config can be exercised in isolation (wiring tests) without a DB.
 */
export function buildPinoHttpOptions(nodeEnv: string) {
  const isDev = nodeEnv === 'development';
  return {
    level: isDev ? 'debug' : 'info',
    redact: { paths: REDACT_PATHS, remove: true },
    serializers: { req: serializeRequest, res: serializeResponse },
    transport: isDev ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
  };
}

/**
 * The nestjs-pino module params (exported for the wiring test, which mounts them on Fastify).
 *
 * `forRoutes` is explicit (run 96): nestjs-pino 5.3's default `{/*splat}` has no leading slash on
 * purpose, but @fastify/middie >= 9.3.6 prefixes one (`/{/*splat}`), which matches only `/`, so
 * every other route lost its access line. `/{*splat}` is a wildcard Nest recognises and matches `/`
 * too. No global prefix is set, so nestjs-pino's prefix-exclusion routes do not apply.
 */
export function buildLoggerParams(nodeEnv: string) {
  return {
    pinoHttp: buildPinoHttpOptions(nodeEnv),
    forRoutes: [{ path: '/{*splat}', method: RequestMethod.ALL }],
  };
}

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        buildLoggerParams(config.getOrThrow<AppConfig>('app').nodeEnv),
    }),
  ],
})
export class LoggerModule {}
