import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import type { AppConfig } from '../../config/configuration';

/**
 * Structured logging with nestjs-pino (B1.3, INV-20).
 *
 * Redacts sensitive fields so credentials/tokens never reach the logs, and
 * attaches a request id to every HTTP log line. In development the output is
 * pretty-printed; in production it stays as JSON.
 */

/**
 * Redaction paths cover both request/response bodies and headers. Wildcards
 * (`*`) catch the field at any nesting depth. `remove: true` drops the field
 * entirely rather than replacing it with `[Redacted]`.
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

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const { nodeEnv } = config.getOrThrow<AppConfig>('app');
        const isDev = nodeEnv === 'development';
        return {
          pinoHttp: {
            level: isDev ? 'debug' : 'info',
            genReqId: (req, res) => {
              const existing = req.headers['x-request-id'];
              const id = (Array.isArray(existing) ? existing[0] : existing) ?? randomUUID();
              res.setHeader('x-request-id', id);
              return id;
            },
            redact: { paths: REDACT_PATHS, remove: true },
            transport: isDev ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
          },
        };
      },
    }),
  ],
})
export class LoggerModule {}
