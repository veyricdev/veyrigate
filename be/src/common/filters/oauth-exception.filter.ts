import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

/**
 * Minimal Fastify reply shape used by this filter. Declared structurally to
 * avoid importing `fastify` directly (it is only a transitive dependency of
 * `@nestjs/platform-fastify`).
 */
interface HttpReply {
  status(code: number): { send(payload: unknown): unknown };
}

/**
 * Global exception filter that renders errors in the OAuth 2.0 error format
 * (RFC 6749 §5.2): `{ error, error_description }` (B1.3).
 *
 * - `HttpException`s map their status to a matching OAuth `error` code and use
 *   their message as `error_description`.
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

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      error = this.errorCodeForStatus(status);
      description = this.describe(exception);
    } else {
      this.logger.error(
        exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
      );
    }

    void reply.status(status).send({ error, error_description: description });
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
