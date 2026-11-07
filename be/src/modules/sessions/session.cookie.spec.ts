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

  it('Secure => sets __Host-idp_session with HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=absolute; no Domain (DEBT-008)', async () => {
    app = await makeApp(true);
    const header = String((await inject('/set')).headers['set-cookie']);
    expect(header).toMatch(/^__Host-idp_session=opaque-random-id;/);
    expect(header).toMatch(/; HttpOnly/);
    expect(header).toMatch(/; Secure/);
    expect(header).toMatch(/; SameSite=Lax/);
    expect(header).toMatch(/; Path=\/(;|$)/);
    expect(header).toMatch(/; Max-Age=2592000/);
    expect(header).not.toMatch(/Domain=/i);
  });

  it('dev flag false => legacy name idp_session without Secure (http dev/E2E)', async () => {
    app = await makeApp(false);
    const header = String((await inject('/set')).headers['set-cookie']);
    expect(header).toMatch(/^idp_session=opaque-random-id;/);
    expect(header).not.toMatch(/Secure/);
    expect(header).not.toMatch(/__Host-/);
    expect(header).toMatch(/HttpOnly/);
    expect(header).not.toMatch(/Domain=/i);
  });

  it('clear uses the same name + attributes and expires the cookie', async () => {
    app = await makeApp(true);
    const header = String((await inject('/clear')).headers['set-cookie']);
    expect(header).toMatch(/^__Host-idp_session=;/);
    expect(header).toMatch(/Max-Age=0/);
    expect(header).toMatch(/HttpOnly; .*Secure|Secure; .*HttpOnly/);
    expect(header).toMatch(/SameSite=Lax/);
    expect(header).toMatch(/Path=\//);
    expect(header).not.toMatch(/Domain=/i);
  });

  it('reads the cookie value; missing/empty → undefined', async () => {
    app = await makeApp(true);
    expect((await inject('/read', { cookie: '__Host-idp_session=abc' })).json()).toEqual({
      id: 'abc',
    });
    expect((await inject('/read')).json()).toEqual({ id: null });
    expect((await inject('/read', { cookie: '__Host-idp_session=' })).json()).toEqual({ id: null });
  });

  it('Secure => the legacy idp_session cookie is ignored, never a fallback (hard cut, tossing)', async () => {
    app = await makeApp(true);
    expect((await inject('/read', { cookie: 'idp_session=abc' })).json()).toEqual({ id: null });
    // Both present (a sibling subdomain tossed the legacy name): only the __Host- one counts.
    expect(
      (await inject('/read', { cookie: 'idp_session=tossed; __Host-idp_session=real' })).json(),
    ).toEqual({ id: 'real' });
  });

  it('non-Secure => reads only idp_session (the __Host- name belongs to Secure mode)', async () => {
    app = await makeApp(false);
    expect((await inject('/read', { cookie: 'idp_session=abc' })).json()).toEqual({ id: 'abc' });
    expect((await inject('/read', { cookie: '__Host-idp_session=abc' })).json()).toEqual({
      id: null,
    });
  });

  it('exposes the name derived from the one flag', () => {
    expect(new SessionCookie(makeConfig(true)).name).toBe('__Host-idp_session');
    expect(new SessionCookie(makeConfig(false)).name).toBe('idp_session');
  });
});
