import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { errorForLog } from '../logger/error-log';

/**
 * Minimal Fastify reply shape used by this filter. Declared structurally to
 * avoid importing `fastify` directly (it is only a transitive dependency of
 * `@nestjs/platform-fastify`).
 */
interface HttpReply {
  header(name: string, value: string): HttpReply;
  status(code: number): { send(payload: unknown): unknown };
}

/**
 * The status of a non-`HttpException` `Error` carrying an integer 4xx `statusCode` (Fastify core and
 * its plugins report client errors this way, e.g. @fastify/static 403 on a non-canonical path),
 * else `undefined`. Anything else stays a 500.
 */
export function clientErrorStatus(exception: unknown): number | undefined {
  if (!(exception instanceof Error)) return undefined;
  const status = (exception as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 499
    ? status
    : undefined;
}

/**
 * Global exception filter that renders errors in the OAuth 2.0 error format
 * (RFC 6749 §5.2): `{ error, error_description }` (B1.3).
 *
 * - `HttpException`s map their status to a matching OAuth `error` code and use
 *   their message as `error_description`.
 * - A non-HttpException with a 4xx `statusCode` keeps that status (see `clientErrorStatus`).
 * - Anything else is a `server_error` with a generic description (details are
 *   logged, not leaked to the client).
 */
@Catch()
export class OAuthExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(OAuthExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<HttpReply>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let error = 'server_error';
    let description = 'The authorization server encountered an unexpected condition.';
    const clientStatus = clientErrorStatus(exception);

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      error = this.errorCodeForStatus(status);
      description = this.describe(exception);
    } else if (clientStatus !== undefined) {
      // Client error, not a server fault: its status, a generic description (never its message)
      // and no error log, so an anonymous client cannot raise 5xx metrics/alerts or log noise (B7.4).
      status = clientStatus;
      error = this.errorCodeForStatus(status);
      description = 'The request could not be completed.';
    } else {
      // Name + code + frames only: the message may carry input/DB values (B7.4).
      this.logger.error(errorForLog(exception));
    }

    // Error bodies are per-request and may follow a credential exchange: never cached (B7.4).
    void reply
      .header('Cache-Control', 'no-store')
      .status(status)
      .send({ error, error_description: description });
  }

  private errorCodeForStatus(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'invalid_request';
      case HttpStatus.UNAUTHORIZED:
        return 'invalid_client';
      case HttpStatus.FORBIDDEN:
        return 'access_denied';
      case HttpStatus.NOT_FOUND:
        return 'invalid_request';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'temporarily_unavailable';
      default:
        return status >= 500 ? 'server_error' : 'invalid_request';
    }
  }

  private describe(exception: HttpException): string {
    const response = exception.getResponse();
    if (typeof response === 'string') {
      return response;
    }
    const message = (response as { message?: string | string[] }).message;
    if (Array.isArray(message)) {
      return message.join('; ');
    }
    return message ?? exception.message;
  }
}
