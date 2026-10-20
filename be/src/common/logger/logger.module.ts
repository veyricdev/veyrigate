import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import type { AppConfig } from '../../config/configuration';

/**
 * Structured logging with nestjs-pino (B1.3, INV-20).
 *
 * Redacts sensitive fields so credentials/tokens never reach the logs, and
 * surfaces the `genReqId` request id (`req.id`) on every HTTP log line so
 * access logs stay correlatable with audit entries. In development the output
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
  // `id` is the non-secret `genReqId` value (correlates access log <-> audit).
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
    genReqId: (
      req: { headers: Record<string, string | string[] | undefined> },
      res: { setHeader: (name: string, value: string) => void },
    ) => {
      const existing = req.headers['x-request-id'];
      const id = (Array.isArray(existing) ? existing[0] : existing) ?? randomUUID();
      res.setHeader('x-request-id', id);
      return id;
    },
    redact: { paths: REDACT_PATHS, remove: true },
    serializers: { req: serializeRequest, res: serializeResponse },
    transport: isDev ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
  };
}

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const { nodeEnv } = config.getOrThrow<AppConfig>('app');
        return { pinoHttp: buildPinoHttpOptions(nodeEnv) };
      },
    }),
  ],
})
export class LoggerModule {}
