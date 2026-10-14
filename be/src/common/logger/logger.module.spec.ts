import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { createServer, get as httpGet, type Server } from 'node:http';
import { Writable } from 'node:stream';
import { pinoHttp } from 'pino-http';
import { buildPinoHttpOptions, serializeRequest, serializeResponse } from './logger.module';

describe('request log serializer', () => {
  it('drops query strings containing one-time tokens', () => {
    expect(serializeRequest({ method: 'GET', url: '/reset?token=top-secret' })).toEqual({
      id: undefined,
      method: 'GET',
      url: '/reset',
    });
    expect(
      JSON.stringify(serializeRequest({ method: 'GET', url: '/verify-email?token=top-secret' })),
    ).not.toContain('top-secret');
  });

  it('surfaces the genReqId request id so access logs stay correlatable', () => {
    expect(serializeRequest({ id: 'req-42', method: 'GET', url: '/authorize?code=C' })).toEqual({
      id: 'req-42',
      method: 'GET',
      url: '/authorize',
    });
  });

  it('keeps only the path for OIDC endpoints carrying sensitive query params', () => {
    expect(serializeRequest({ method: 'GET', url: '/logout?id_token_hint=H&state=S' })).toEqual({
      id: undefined,
      method: 'GET',
      url: '/logout',
    });
    expect(
      serializeRequest({ method: 'GET', url: '/authorize?login_hint=L&code_challenge=P' }),
    ).toEqual({ id: undefined, method: 'GET', url: '/authorize' });
    expect(
      JSON.stringify(serializeRequest({ method: 'GET', url: '/logout?id_token_hint=H&state=S' })),
    ).not.toMatch(/id_token_hint|state=/);
  });
});

describe('response log serializer', () => {
  it('scrubs query + fragment off an absolute redirect location (authz code/state)', () => {
    const out = serializeResponse({
      statusCode: 302,
      headers: { location: 'https://rp.example/cb?code=C&state=S#x' },
    });
    expect(out).toEqual({ statusCode: 302, headers: { location: 'https://rp.example/cb' } });
    expect(JSON.stringify(out)).not.toMatch(/code=|state=/);
  });

  it('scrubs query off a relative redirect location', () => {
    const out = serializeResponse({
      statusCode: 302,
      headers: { location: '/login?returnTo=%2Fauthorize%3Flogin_hint%3DL' },
    });
    expect(out).toEqual({ statusCode: 302, headers: { location: '/login' } });
  });

  it('drops the location key when absent or not a string (fail-closed)', () => {
    expect(serializeResponse({ statusCode: 204, headers: {} })).toEqual({
      statusCode: 204,
      headers: {},
    });
    expect(
      serializeResponse({ statusCode: 302, headers: { location: 12345 as unknown as string } }),
    ).toEqual({ statusCode: 302, headers: {} });
  });

  it('never surfaces set-cookie / x-request-id via the allow-list', () => {
    const out = serializeResponse({
      statusCode: 302,
      headers: {
        location: 'https://rp.example/cb?code=C',
        'set-cookie': 'idp_session=SECRET_SID',
        'x-request-id': 'req-1',
      } as Record<string, unknown>,
    });
    expect(JSON.stringify(out)).not.toMatch(/set-cookie|idp_session|x-request-id|SECRET_SID/);
    expect(out.headers.location).toBe('https://rp.example/cb');
  });
});

describe('pino-http wiring (no DB)', () => {
  let server: Server;
  let port: number;
  let logs = '';
  const memStream = new Writable({
    write(chunk, _enc, cb) {
      logs += chunk.toString();
      cb();
    },
  });

  beforeAll(async () => {
    // Exercise the real pino-http pipeline (not just the serializer) with the
    // exact options production uses.
    const logger = pinoHttp(buildPinoHttpOptions('test') as never, memStream);
    server = createServer((req, res) => {
      logger(req, res);
      res.writeHead(302, {
        Location: 'https://rp.example/cb?code=SECRET_CODE&state=SECRET_STATE#frag',
        'Set-Cookie': 'idp_session=SECRET_SID',
      });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('scrubs secrets yet keeps the request id for the completed 302 log line', async () => {
    logs = '';
    await new Promise<void>((resolve, reject) => {
      httpGet(
        {
          port,
          path: '/authorize?id_token_hint=SECRET_HINT&login_hint=SECRET_LH',
          headers: {
            'x-request-id': 'REQ-CORRELATE-1',
            authorization: 'Bearer SECRET_BEARER',
            cookie: 'idp_session=SECRET_SID',
          },
        },
        (res) => {
          res.resume();
          res.on('end', resolve);
          res.on('error', reject);
        },
      );
    });
    // Poll until the "request completed" line is flushed (no fixed timing).
    const deadline = Date.now() + 2000;
    while (!logs.includes('request completed') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(logs).not.toContain('SECRET_');

    const completed = logs
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((entry) => entry.msg === 'request completed') as
      | {
          req: { id?: unknown };
          res: { statusCode?: number; headers: Record<string, unknown> };
        }
      | undefined;
    expect(completed).toBeDefined();
    expect(completed?.req.id).toBe('REQ-CORRELATE-1');
    expect(completed?.res.statusCode).toBe(302);
    expect(completed?.res.headers.location).toBe('https://rp.example/cb');
    expect(Object.keys(completed?.res.headers ?? {})).toEqual(['location']);
  });
});
