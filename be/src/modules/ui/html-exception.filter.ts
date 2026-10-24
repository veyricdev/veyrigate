import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { clientErrorStatus } from '../../common/filters/oauth-exception.filter';
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
    const response = exception instanceof HttpException ? exception.getResponse() : undefined;
    const retryAfter =
      typeof response === 'object' && response && 'retryAfter' in response
        ? String((response as { retryAfter: unknown }).retryAfter)
        : undefined;
    if (status === 429 && retryAfter) reply.header('Retry-After', retryAfter);
    if (unavailable) reply.header('Retry-After', String(DEPENDENCY_RETRY_AFTER_SEC));
    // Error pages are per-request (may follow a credential form post): never cached (B7.4).
    reply.header('Cache-Control', 'no-store');
    void reply.status(status).view('error.eta', {
      title: 'Request failed',
      message:
        status === 429
          ? 'Too many requests. Please try again later.'
          : unavailable
            ? 'The service is temporarily unavailable. Please try again in a few seconds.'
            : status < 500
              ? 'The request could not be completed.'
              : 'Something went wrong.',
    });
  }
}
