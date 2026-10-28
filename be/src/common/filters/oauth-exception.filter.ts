import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { types } from 'node:util';
import { errorForLog } from '../logger/error-log';
import {
  DEPENDENCY_RETRY_AFTER_SEC,
  DEPENDENCY_UNAVAILABLE_DESCRIPTION,
  isDependencyUnavailable,
} from '../errors/dependency-unavailable';

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
 *
 * Run 58 (DEBT-238): only when `code` is absent or a Fastify `FST_*` code. An outbound SDK error
 * carrying `statusCode` 4xx plus its own `code` is a server fault (500 + error log), never the
 * upstream's status. Invariant: outbound clients wrap their errors (`providerFetchJson`;
 * `VaultStatusError` uses `status`, not `statusCode`). An `http-errors`-style error without `code`
 * is still taken as a client error — accepted, no runtime dependency throws one (senior run 38).
 *
 * Run 58 retry 1: the ONLY accepted non-`FST_` code is Fastify's mid-body client abort —
 * `fastify/lib/content-type-parser.js` rawBody `onEnd` tags the request stream's Node
 * `ConnResetException('aborted')` (`code: 'ECONNRESET'`) with `statusCode` 400 — matched exactly.
 * Accepted residual risk: an SDK copying `statusCode: 400` onto an upstream `ECONNRESET 'aborted'`
 * would become a 400 without a log; no runtime dependency does that.
 * The guard also accepts a native Error from another realm (`types.isNativeError`, Jest VM);
 * `instanceof` is still needed for `@fastify/error` errors, which are not native.
 */
export function clientErrorStatus(exception: unknown): number | undefined {
  if (!(exception instanceof Error) && !types.isNativeError(exception)) return undefined;
  const {
    statusCode: status,
    code,
    message,
  } = exception as { statusCode?: unknown; code?: unknown; message?: unknown };
  // Fastify rawBody tags the request stream's own abort error with 400 (client gone mid-body).
  const fastifyBodyAbort = code === 'ECONNRESET' && status === 400 && message === 'aborted';
  if (
    !fastifyBodyAbort &&
    code !== undefined &&
    !(typeof code === 'string' && code.startsWith('FST_'))
  ) {
    return undefined;
  }
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
 * - A dependency outage (Redis/key provider, run 53c) is 503 `temporarily_unavailable` +
 *   `Retry-After` (still logged like a 500).
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
      if (isDependencyUnavailable(exception)) {
        status = HttpStatus.SERVICE_UNAVAILABLE;
        error = 'temporarily_unavailable';
        description = DEPENDENCY_UNAVAILABLE_DESCRIPTION;
        reply.header('Retry-After', String(DEPENDENCY_RETRY_AFTER_SEC));
      }
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
