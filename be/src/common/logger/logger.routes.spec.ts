import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Controller, Get, Module, Post, Res } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { Writable } from 'node:stream';
import { buildLoggerParams } from './logger.module';

/**
 * Run 96 (retry 1): the access log must cover EVERY route, not just `/`. nestjs-pino 5.3's default
 * route `{/*splat}` (no leading slash) is mounted by @fastify/middie >= 9.3.6 as `/{/*splat}`, which
 * only matches `/`. This mounts the production module params on a real Fastify adapter (the wiring
 * the int suites use) so a route-matching regression is caught by the unit gate.
 */
@Controller()
class ProbeController {
  @Get()
  root() {
    return 'root';
  }

  @Post('login')
  login(@Res({ passthrough: true }) reply: { header(name: string, value: string): unknown }) {
    reply.header('set-cookie', 'idp_session=SECRET_SID; Path=/; HttpOnly');
    return 'ok';
  }

  @Post('token')
  token() {
    return { access_token: 'SECRET_AT' };
  }

  @Get('admin/api/users')
  users() {
    return [];
  }
}

describe('access log covers every route (nestjs-pino on Fastify)', () => {
  let app: NestFastifyApplication;
  let logs = '';
  let seq = 0;
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logs += chunk.toString();
      cb();
    },
  });

  beforeAll(async () => {
    const params = buildLoggerParams('test');
    @Module({
      imports: [
        PinoLoggerModule.forRoot({ ...params, pinoHttp: [params.pinoHttp as never, stream] }),
      ],
      controllers: [ProbeController],
    })
    class ProbeModule {}
    app = await NestFactory.create<NestFastifyApplication>(
      ProbeModule,
      new FastifyAdapter({ genReqId: () => `rid-${++seq}` }),
      { logger: false },
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const completed = () =>
    logs
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { msg?: string; req?: { id?: string; url?: string } })
      .filter((entry) => entry.msg === 'request completed');

  it.each([
    ['GET', '/', 200],
    ['POST', '/login', 201],
    ['POST', '/token', 201],
    ['GET', '/admin/api/users?cursor=x', 200],
    ['GET', '/no-such-route', 404],
  ] as const)(
    '%s %s logs one `request completed` line with its req.id',
    async (method, url, status) => {
      logs = '';
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(status);
      const lines = completed();
      expect(lines).toHaveLength(1);
      expect(lines[0].req?.id).toBe(`rid-${seq}`);
      expect(lines[0].req?.url).toBe(url.split('?', 1)[0]);
    },
  );

  it('logs the response without set-cookie or the body (nestjs-pino onSend hook + allow-list)', async () => {
    logs = '';
    const res = await app.inject({ method: 'POST', url: '/login' });
    expect(res.headers['set-cookie']).toContain('SECRET_SID');
    expect(completed()).toHaveLength(1);
    expect(logs).not.toMatch(/SECRET_|set-cookie|idp_session/i);
    logs = '';
    await app.inject({ method: 'POST', url: '/token' });
    expect(completed()).toHaveLength(1);
    expect(logs).not.toContain('SECRET_AT');
  });
});
