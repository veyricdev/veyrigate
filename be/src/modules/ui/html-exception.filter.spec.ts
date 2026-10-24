import type { ArgumentsHost } from '@nestjs/common';
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
