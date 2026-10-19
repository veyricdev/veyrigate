import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { existsSync } from 'node:fs';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import type { AppConfig } from './config/configuration';
import { assertTrustProxyConsistent, parseTrustProxy } from './config/trust-proxy';

async function bootstrap(): Promise<void> {
  // Load `.env` BEFORE anything reads `process.env` (R3). `@nestjs/config` only copies `.env` into
  // `process.env` inside `ConfigModule.forRoot` — which runs while AppModule is built, i.e. AFTER
  // the FastifyAdapter below already parsed `TRUST_PROXY`. Loading it here (same default path as
  // `@nestjs/config`, non-overriding: existing real env vars win) keeps the adapter and the typed
  // config reading the SAME value. No-op when `.env` is absent (e.g. container env-only deploys).
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }

  // `trustProxy` (DEBT-006) must be set when the adapter is constructed — before ConfigModule's
  // validation runs — so it is parsed directly from env here with the SAME pure function the typed
  // config (and the integration tests) use. parseTrustProxy throws on `true`/numeric/invalid input,
  // keeping the fail-fast bootstrap contract. Disabled by default (socket IP only). The result is
  // `false | string[]`, both valid Fastify `trustProxy` values, so no cast is needed.
  const parsedTrustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: parsedTrustProxy }),
    { bufferLogs: true },
  );

  await configureApp(app);

  const appConfig = app.get(ConfigService).getOrThrow<AppConfig>('app');
  // Fail fast if the adapter's trustProxy (parsed pre-bootstrap) and the typed config disagree —
  // this is the sole reader of `app.trustProxy`, keeping the two parse sites honest.
  assertTrustProxyConsistent(parsedTrustProxy, appConfig.trustProxy);
  await app.listen({ port: appConfig.port, host: '0.0.0.0' });
}

void bootstrap();
