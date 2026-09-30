import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';

interface Reply {
  status(code: number): Reply;
  header(name: string, value: string): Reply;
  view(template: string, data: object): unknown;
}
@Catch()
export class HtmlExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<Reply>();
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const response = exception instanceof HttpException ? exception.getResponse() : undefined;
    const retryAfter =
      typeof response === 'object' && response && 'retryAfter' in response
        ? String((response as { retryAfter: unknown }).retryAfter)
        : undefined;
    if (status === 429 && retryAfter) reply.header('Retry-After', retryAfter);
    void reply.status(status).view('error.eta', {
      title: 'Request failed',
      message:
        status === 429
          ? 'Too many requests. Please try again later.'
          : status < 500
            ? 'The request could not be completed.'
            : 'Something went wrong.',
    });
  }
}
