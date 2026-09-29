import cookie from '@fastify/cookie';
import { Controller, Get, Req, Res } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { SessionCookie } from './session.cookie';

const makeConfig = (cookieSecure: boolean) =>
  ({
    getOrThrow: (ns: string) =>
      ns === 'session' ? { cookieSecure } : { sessionAbsoluteTtl: 2592000, sessionIdleTtl: 28800 },
  }) as unknown as ConfigService;

async function makeApp(secure: boolean): Promise<NestFastifyApplication> {
  const sc = new SessionCookie(makeConfig(secure));
  @Controller()
  class C {
    @Get('set')
    set(@Res({ passthrough: true }) res: Parameters<SessionCookie['set']>[0]) {
      sc.set(res, 'opaque-random-id');
      return {};
    }
    @Get('clear')
    clear(@Res({ passthrough: true }) res: Parameters<SessionCookie['clear']>[0]) {
      sc.clear(res);
      return {};
    }
    @Get('read')
    read(@Req() req: Parameters<SessionCookie['read']>[0]) {
      return { id: sc.read(req) ?? null };
    }
  }
  const moduleRef = await Test.createTestingModule({ controllers: [C] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.register(cookie);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe('SessionCookie (B2.3, INV-16, C8)', () => {
  let app: NestFastifyApplication;
  afterEach(async () => app?.close());

  const inject = (url: string, headers: Record<string, string> = {}) =>
    app.getHttpAdapter().getInstance().inject({ method: 'GET', url, headers });

  it('sets idp_session with HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=absolute; no Domain', async () => {
    app = await makeApp(true);
    const header = String((await inject('/set')).headers['set-cookie']);
    expect(header).toMatch(/^idp_session=opaque-random-id;/);
    expect(header).toMatch(/; HttpOnly/);
    expect(header).toMatch(/; Secure/);
    expect(header).toMatch(/; SameSite=Lax/);
    expect(header).toMatch(/; Path=\//);
    expect(header).toMatch(/; Max-Age=2592000/);
    expect(header).not.toMatch(/Domain=/i);
  });

  it('omits Secure only when the dev flag is false', async () => {
    app = await makeApp(false);
    const header = String((await inject('/set')).headers['set-cookie']);
    expect(header).not.toMatch(/Secure/);
    expect(header).toMatch(/HttpOnly/);
  });

  it('clear uses the same attributes and expires the cookie', async () => {
    app = await makeApp(true);
    const header = String((await inject('/clear')).headers['set-cookie']);
    expect(header).toMatch(/^idp_session=;/);
    expect(header).toMatch(/Max-Age=0/);
    expect(header).toMatch(/HttpOnly; .*Secure|Secure; .*HttpOnly/);
    expect(header).toMatch(/SameSite=Lax/);
    expect(header).toMatch(/Path=\//);
  });

  it('reads the cookie value; missing/empty → undefined', async () => {
    app = await makeApp(true);
    expect((await inject('/read', { cookie: 'idp_session=abc' })).json()).toEqual({ id: 'abc' });
    expect((await inject('/read')).json()).toEqual({ id: null });
    expect((await inject('/read', { cookie: 'idp_session=' })).json()).toEqual({ id: null });
  });
});
