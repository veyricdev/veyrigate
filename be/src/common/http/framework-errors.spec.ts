import { Logger } from '@nestjs/common';
import { jest } from '@jest/globals';
import { registry } from '../metrics/metrics';
import { frameworkErrors } from './framework-errors';

/** Pre-routing Fastify errors (DEBT-239). The HTTP paths (400/414) are covered by b74-tester. */
function fakeReply() {
  const state = { status: 0, headers: {} as Record<string, string>, body: undefined as unknown };
  const reply = {
    elapsedTime: 0,
    code: (s: number) => void (state.status = s),
    headers: (h: Record<string, string>) => void Object.assign(state.headers, h),
    send: (p?: unknown) => void (state.body = p),
  } as unknown as Parameters<typeof frameworkErrors>[2];
  return { state, reply };
}

async function count(cls: string): Promise<number> {
  const text = await registry.metrics();
  const line = text
    .split('\n')
    .find(
      (l) =>
        l.startsWith('sso_http_request_duration_seconds_count{') &&
        l.includes('route="__unmatched"') &&
        l.includes('method="OTHER"') &&
        l.includes(`status_class="${cls}"`),
    );
  return line ? Number(line.slice(line.lastIndexOf(' ') + 1)) : 0;
}

describe('frameworkErrors', () => {
  afterEach(() => jest.restoreAllMocks());

  it('a non-4xx statusCode => 500 server_error, full headers, one error log with only the code', async () => {
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const before = await count('5xx');
    const { state, reply } = fakeReply();
    frameworkErrors(
      Object.assign(new Error('secret-path /x'), { statusCode: 500, code: 'FST_X' }),
      { method: 'BREW' },
      reply,
    );
    expect(state.status).toBe(500);
    expect(state.body).toBe('{"error":"server_error"}');
    expect(state.headers['cache-control']).toBe('no-store');
    expect(state.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(state.headers['content-security-policy']).toContain("default-src 'self'");
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain('FST_X');
    expect(String(log.mock.calls[0][0])).not.toContain('secret-path');
    expect(await count('5xx')).toBe(before + 1);
  });

  it.each([[undefined], ['414'], [399], [500.5]])(
    'statusCode %p is not trusted as 4xx => 500',
    (statusCode) => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const { state, reply } = fakeReply();
      frameworkErrors({ statusCode }, { method: 'GET' }, reply);
      expect(state.status).toBe(500);
    },
  );

  it('a 4xx statusCode => fixed invalid_request body, no error log, never the message', async () => {
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const before = await count('4xx');
    const { state, reply } = fakeReply();
    frameworkErrors(
      Object.assign(new Error("'/%zz' is not a valid url component"), { statusCode: 400 }),
      { method: 'BREW' },
      reply,
    );
    expect(state.status).toBe(400);
    expect(state.body).toBe('{"error":"invalid_request"}');
    expect(log).not.toHaveBeenCalled();
    expect(await count('4xx')).toBe(before + 1);
  });
});
