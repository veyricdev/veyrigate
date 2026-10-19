import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import type { AppConfig } from '../../src/config/configuration';
import { assertTrustProxyConsistent, parseTrustProxy } from '../../src/config/trust-proxy';
import { FEDERATION_PROVIDERS } from '../../src/modules/federation/providers';
import { startMockGoogle } from './mock-google';

/**
 * E2E-only entry point (X4, DEBT-184, F18). Same app as `src/main.ts` (AppModule + `configureApp`)
 * except the static federation registry is replaced through the `FEDERATION_PROVIDERS` DI token by
 * an in-process mock Google on 127.0.0.1. The mock URL exists only in this file's process: no env,
 * DB or request can carry a provider URL (INV-23). Lives outside `src/` (never in `dist/`, guarded
 * by `assert-dist-clean.mjs`) and refuses to run in production. Env comes only from the E2E harness
 * (`be/.env` is not loaded).
 */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('e2e-main must never run with NODE_ENV=production');
  }
  const issuer = process.env.ISSUER;
  if (!issuer) throw new Error('ISSUER is required');
  const mock = await startMockGoogle(new URL('/auth/google/callback', issuer).href);

  const parsedTrustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(FEDERATION_PROVIDERS)
    .useValue(mock.registry)
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ trustProxy: parsedTrustProxy }),
    { bufferLogs: true },
  );
  await configureApp(app);

  const appConfig = app.get(ConfigService).getOrThrow<AppConfig>('app');
  assertTrustProxyConsistent(parsedTrustProxy, appConfig.trustProxy);
  await app.listen({ port: appConfig.port, host: '0.0.0.0' });
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'e2e-main failed');
  process.exit(1);
});
