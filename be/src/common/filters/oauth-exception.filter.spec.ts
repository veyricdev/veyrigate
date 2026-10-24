import { describe, expect, it, jest } from '@jest/globals';
import type { ArgumentsHost } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { OAuthExceptionFilter } from './oauth-exception.filter';

function run(exception: unknown) {
  const sent: { status?: number; body?: unknown; headers: Record<string, string> } = {
    headers: {},
  };
  const reply = {
    header(name: string, value: string) {
      sent.headers[name] = value;
      return reply;
    },
    status(code: number) {
      sent.status = code;
      return { send: (body: unknown) => (sent.body = body) };
    },
  };
  const host = { switchToHttp: () => ({ getResponse: () => reply }) } as unknown as ArgumentsHost;
  const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  try {
    new OAuthExceptionFilter().catch(exception, host);
    return { ...sent, errorLogged: error.mock.calls.length > 0 };
  } finally {
    error.mockRestore();
  }
}

describe('OAuthExceptionFilter: non-HttpException carrying a statusCode (B7.4 retry 1)', () => {
  it('a 4xx statusCode (e.g. @fastify/static forbidden path) => that status, safe body, no error log', () => {
    const err = Object.assign(new Error('Forbidden secret-detail'), {
      statusCode: 403,
      status: 403,
    });
    const out = run(err);
    expect(out.status).toBe(403);
    expect(out.body).toEqual({
      error: 'access_denied',
      error_description: 'The request could not be completed.',
    });
    expect(JSON.stringify(out.body)).not.toContain('secret-detail');
    expect(out.headers['Cache-Control']).toBe('no-store');
    expect(out.errorLogged).toBe(false);
  });

  it.each([500, 503, 399, 600, 403.5, '403', NaN])(
    'statusCode %p is not a client error => 500 server_error + error log',
    (statusCode) => {
      const out = run(Object.assign(new Error('x'), { statusCode }));
      expect(out.status).toBe(500);
      expect((out.body as { error: string }).error).toBe('server_error');
      expect(out.errorLogged).toBe(true);
    },
  );

  it('a non-Error object with a 4xx statusCode is still a 500', () => {
    const out = run({ statusCode: 404 });
    expect(out.status).toBe(500);
    expect(out.errorLogged).toBe(true);
  });
});

describe('OAuthExceptionFilter: dependency outage (run 53c)', () => {
  it('Redis "Command timed out" ⇒ 503 temporarily_unavailable + Retry-After 5 + no-store, logged', () => {
    const out = run(new Error('Command timed out'));
    expect(out.status).toBe(503);
    expect(out.body).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'The service is temporarily unavailable. Try again later.',
    });
    expect(out.headers['Retry-After']).toBe('5');
    expect(out.headers['Cache-Control']).toBe('no-store');
    expect(out.errorLogged).toBe(true);
  });

  it('an unrelated Error stays 500 server_error without Retry-After', () => {
    const out = run(new Error('redis down'));
    expect(out.status).toBe(500);
    expect(out.headers['Retry-After']).toBeUndefined();
  });
});
