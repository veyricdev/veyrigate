import { Controller, Get, Module } from '@nestjs/common';
import { ConditionalModule, ConfigModule as NestConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { registerCorsPreflight } from '../clients/client-cors.helper';
import { isDemoEnabled } from './demo.enabled';

/**
 * QA (run 24 tester) — route-level gating of the dev/test-only demo resource (Task 1, Q-24.2).
 *
 * `demo.enabled.spec.ts` only covers the pure predicate. This proves the WIRING semantics the app
 * relies on: `ConditionalModule.registerWhen(<module>, (env) => isDemoEnabled(env))` (the exact
 * expression in `AppModule`) mounts NO route when NODE_ENV is unset/production (=> 404), and the
 * `main.ts` preflight expression (`isDemoEnabled(process.env) ? new Set(['/demo/me']) : undefined`)
 * gives NO preflight 204 when disabled. A stub controller stands in for `DemoController` so the
 * test needs no Mongo/Redis; the real controller is covered by `test/demo.int-spec.ts`.
 */
@Controller()
class StubDemoController {
  @Get('/demo/me')
  me() {
    return { ok: true };
  }
}

@Module({ controllers: [StubDemoController] })
class StubDemoModule {}

const ORIGIN = 'http://localhost:5173';

async function boot(nodeEnv: string | undefined): Promise<NestFastifyApplication> {
  const saved = process.env.NODE_ENV;
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  try {
    const moduleRef = await Test.createTestingModule({
      imports: [
        // ignoreEnvFile: isolate from be/.env (which sets NODE_ENV=development).
        NestConfigModule.forRoot({ ignoreEnvFile: true }),
        ConditionalModule.registerWhen(StubDemoModule, (env) => isDemoEnabled(env), {
          debug: false,
        }),
      ],
    }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // Same expression as main.ts, evaluated against the same env.
    const extra = isDemoEnabled(process.env) ? new Set(['/demo/me']) : undefined;
    registerCorsPreflight(
      app.getHttpAdapter().getInstance(),
      { isOriginRegisteredForAnyClient: async (o) => o === ORIGIN },
      extra,
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app;
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  }
}

describe('demo resource route-level gating (ConditionalModule + preflight wiring)', () => {
  const cases: Array<[string | undefined, boolean]> = [
    ['development', true],
    ['test', true],
    [undefined, false], // unset => OFF (allowlist, DEBT-098: no fail-open to zod default)
    ['production', false],
    ['staging', false],
    ['Development', false], // case-sensitive allowlist
  ];

  it.each(cases)(
    'NODE_ENV=%s => route mounted: %s; preflight 204 only when mounted',
    async (env, on) => {
      const app = await boot(env);
      try {
        const get = await app.inject({ method: 'GET', url: '/demo/me' });
        expect(get.statusCode).toBe(on ? 200 : 404);

        const pre = await app.inject({
          method: 'OPTIONS',
          url: '/demo/me',
          headers: { origin: ORIGIN, 'access-control-request-method': 'GET' },
        });
        if (on) {
          expect(pre.statusCode).toBe(204);
          expect(pre.headers['access-control-allow-origin']).toBe(ORIGIN);
        } else {
          expect(pre.statusCode).not.toBe(204);
          expect(pre.headers['access-control-allow-origin']).toBeUndefined();
        }
      } finally {
        await app.close();
      }
    },
  );
});
