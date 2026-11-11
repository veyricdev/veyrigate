import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { clientErrorStatus } from '../../common/filters/oauth-exception.filter';
import { errorForLog } from '../../common/logger/error-log';
import {
  DEPENDENCY_RETRY_AFTER_SEC,
  isDependencyUnavailable,
} from '../../common/errors/dependency-unavailable';

interface Reply {
  status(code: number): Reply;
  header(name: string, value: string): Reply;
  view(template: string, data: object): unknown;
}
@Catch()
export class HtmlExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HtmlExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<Reply>();
    // Dependency outage (Redis / key provider, run 53c): 503 + Retry-After, never a session/redirect.
    const unavailable = isDependencyUnavailable(exception);
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : unavailable
          ? HttpStatus.SERVICE_UNAVAILABLE
          : (clientErrorStatus(exception) ?? HttpStatus.INTERNAL_SERVER_ERROR);
    // DEBT-237: a 5xx is logged (name/code/frames only, never the message: it may echo input);
    // a 4xx is not, so client input cannot fill the log.
    if (status >= 500) this.logger.error(errorForLog(exception));
    const response = exception instanceof HttpException ? exception.getResponse() : undefined;
    const retryAfter =
      typeof response === 'object' && response && 'retryAfter' in response
        ? String((response as { retryAfter: unknown }).retryAfter)
        : undefined;
    if (status === 429 && retryAfter) reply.header('Retry-After', retryAfter);
    // A 429 may carry its own fixed server-side text (login throttle, DEBT-575); never client input.
    const throttledText =
      status === 429 &&
      typeof response === 'object' &&
      response &&
      typeof (response as { message?: unknown }).message === 'string'
        ? (response as { message: string }).message
        : undefined;
    if (unavailable) reply.header('Retry-After', String(DEPENDENCY_RETRY_AFTER_SEC));
    // Error pages are per-request (may follow a credential form post): never cached (B7.4).
    reply.header('Cache-Control', 'no-store');
    void reply.status(status).view('error.eta', {
      title: 'Request failed',
      message:
        status === 429
          ? (throttledText ?? 'Too many requests. Please try again later.')
          : unavailable
            ? 'The service is temporarily unavailable. Please try again in a few seconds.'
            : status < 500
              ? 'The request could not be completed.'
              : 'Something went wrong.',
    });
  }
}
