import type { ArgumentsHost } from '@nestjs/common';
import { runInNewContext } from 'node:vm';
import { HtmlExceptionFilter } from './html-exception.filter';

function run(exception: unknown) {
  const out: { status?: number; headers: Record<string, string>; view?: unknown } = { headers: {} };
  const reply = {
    status(code: number) {
      out.status = code;
      return reply;
    },
    header(name: string, value: string) {
      out.headers[name] = value;
      return reply;
    },
    view(_t: string, data: object) {
      out.view = data;
    },
  };
  new HtmlExceptionFilter().catch(exception, {
    switchToHttp: () => ({ getResponse: () => reply }),
  } as unknown as ArgumentsHost);
  return out;
}

describe('HtmlExceptionFilter: dependency outage (run 53c)', () => {
  it('Redis "Command timed out" ⇒ 503 page + Retry-After 5 + no-store', () => {
    const out = run(new Error('Command timed out'));
    expect(out.status).toBe(503);
    expect(out.headers['Retry-After']).toBe('5');
    expect(out.headers['Cache-Control']).toBe('no-store');
    expect(JSON.stringify(out.view)).toMatch(/temporarily unavailable/i);
  });

  it('an unrelated Error stays a 500 page without Retry-After', () => {
    const out = run(new Error('boom'));
    expect(out.status).toBe(500);
    expect(out.headers['Retry-After']).toBeUndefined();
  });
});

describe('HtmlExceptionFilter: client error classification (run 58, DEBT-238)', () => {
  it('SDK-shaped error (statusCode 404 + non-Fastify code) ⇒ 500 page, not a 404', () => {
    const out = run(Object.assign(new Error('nf'), { statusCode: 404, code: 'ESDK_NOT_FOUND' }));
    expect(out.status).toBe(500);
  });

  it('retry 1: Fastify rawBody abort (ECONNRESET + 400 + "aborted") ⇒ 400 page', () => {
    const out = run(Object.assign(new Error('aborted'), { code: 'ECONNRESET', statusCode: 400 }));
    expect(out.status).toBe(400);
  });

  it('retry 1: ECONNRESET + "aborted" with statusCode 404 ⇒ 500 page', () => {
    const out = run(Object.assign(new Error('aborted'), { code: 'ECONNRESET', statusCode: 404 }));
    expect(out.status).toBe(500);
  });

  it('U-A1 retry 1: cross-realm native abort Error ⇒ 400 page', () => {
    const out = run(
      runInNewContext(
        'Object.assign(new Error("aborted"), { code: "ECONNRESET", statusCode: 400 })',
      ),
    );
    expect(out.status).toBe(400);
  });

  it('Fastify client error (FST_ code) keeps its 4xx', () => {
    const out = run(
      Object.assign(new Error('x'), { statusCode: 415, code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE' }),
    );
    expect(out.status).toBe(415);
  });
});
