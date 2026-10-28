import { describe, expect, it, jest } from '@jest/globals';
import type { ArgumentsHost } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { runInNewContext } from 'node:vm';
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

  it.each([
    ['an SDK-shaped error (non-Fastify string code)', { statusCode: 404, code: 'ESDK_NOT_FOUND' }],
    ['a numeric code', { statusCode: 403, code: 403 }],
  ])('DEBT-238: %s with a 4xx statusCode => 500 server_error + error log', (_n, fields) => {
    const out = run(Object.assign(new Error('upstream detail'), fields));
    expect(out.status).toBe(500);
    expect((out.body as { error: string }).error).toBe('server_error');
    expect(JSON.stringify(out.body)).not.toContain('upstream detail');
    expect(out.errorLogged).toBe(true);
  });

  it('DEBT-238: a Fastify client error (FST_ code) keeps its 4xx, no error log', () => {
    const out = run(
      Object.assign(new Error('x'), { statusCode: 415, code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE' }),
    );
    expect(out.status).toBe(415);
    expect(out.headers['Cache-Control']).toBe('no-store');
    expect(out.errorLogged).toBe(false);
  });

  it('DEBT-238 retry 1: Fastify rawBody abort (ECONNRESET + 400 + "aborted") => 400 invalid_request, no-store, no error log', () => {
    const out = run(Object.assign(new Error('aborted'), { code: 'ECONNRESET', statusCode: 400 }));
    expect(out.status).toBe(400);
    expect((out.body as { error: string }).error).toBe('invalid_request');
    expect(out.headers['Cache-Control']).toBe('no-store');
    expect(out.errorLogged).toBe(false);
  });

  it.each([
    ['statusCode 404', 'aborted', 'ECONNRESET', 404],
    ['no statusCode (outbound hang-up)', 'aborted', 'ECONNRESET', undefined],
    ['message "socket hang up"', 'socket hang up', 'ECONNRESET', 400],
    ['message "read ECONNRESET"', 'read ECONNRESET', 'ECONNRESET', 400],
    ['code ECONNREFUSED', 'aborted', 'ECONNREFUSED', 400],
  ])(
    'DEBT-238 retry 1: abort look-alike with %s => 500 server_error + error log',
    (_n, message, code, statusCode) => {
      const out = run(Object.assign(new Error(message), { code, statusCode }));
      expect(out.status).toBe(500);
      expect((out.body as { error: string }).error).toBe('server_error');
      expect(out.errorLogged).toBe(true);
    },
  );

  it('DEBT-238 retry 1: a plain object shaped like the abort is still a 500', () => {
    const out = run({ message: 'aborted', code: 'ECONNRESET', statusCode: 400 });
    expect(out.status).toBe(500);
    expect(out.errorLogged).toBe(true);
  });

  it('U-A1 (DEBT-238 retry 1): cross-realm native abort Error => 400 invalid_request, no-store, no error log', () => {
    const out = run(
      runInNewContext(
        'Object.assign(new Error("aborted"), { code: "ECONNRESET", statusCode: 400 })',
      ),
    );
    expect(out.status).toBe(400);
    expect((out.body as { error: string }).error).toBe('invalid_request');
    expect(out.headers['Cache-Control']).toBe('no-store');
    expect(out.errorLogged).toBe(false);
  });

  it.each([
    [
      'U-A2: cross-realm Object.create(Error.prototype) (not native)',
      'Object.assign(Object.create(Error.prototype), { code: "ECONNRESET", statusCode: 400, message: "aborted" })',
    ],
    [
      'U-A3: cross-realm plain object',
      '({ code: "ECONNRESET", statusCode: 400, message: "aborted" })',
    ],
  ])('%s shaped like the abort => 500 + error log', (_n, src) => {
    const out = run(runInNewContext(src));
    expect(out.status).toBe(500);
    expect(out.errorLogged).toBe(true);
  });

  it('U-A4: @fastify/error shape (same realm, Object.create(Error.prototype), FST_ 413) => 413, no error log', () => {
    const out = run(
      Object.assign(Object.create(Error.prototype), {
        code: 'FST_ERR_CTP_BODY_TOO_LARGE',
        statusCode: 413,
        message: 'x',
      }),
    );
    expect(out.status).toBe(413);
    expect(out.errorLogged).toBe(false);
  });

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
