import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import view from '@fastify/view';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { Eta } from 'eta';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { AppModule } from './app.module';
import type { AppConfig } from './config/configuration';
import { assertTrustProxyConsistent, parseTrustProxy } from './config/trust-proxy';
import { ClientCorsService } from './modules/clients/client-cors.service';
import { registerCorsPreflight } from './modules/clients/client-cors.helper';
import { isDemoEnabled } from './modules/demo/demo.enabled';
import { registerAdminOpenApi } from './modules/admin/admin.openapi';

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

  // Structured logging (pino) with redaction (INV-20).
  app.useLogger(app.get(Logger));
  app.flushLogs();

  // Security headers.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  });

  // Cookie parsing/serialisation for `idp_session` (B2.3). Unsigned on purpose:
  // the value is a 256-bit random ID, see SessionCookie.
  await app.register(cookie);
  await app.register(fastifyStatic, { root: join(__dirname, 'public'), prefix: '/assets/' });
  await app.register(view, {
    engine: { eta: new Eta({ views: join(__dirname, 'views'), autoEscape: true }) },
    root: join(__dirname, 'views'),
    layout: 'layout.eta',
  });

  // Dynamic per-client CORS preflight (DEBT-019, spec §9.7). Shared with the integration tests so
  // the production wiring is the exact code under test (see `registerCorsPreflight`). `/demo/me`
  // only answers preflight when the dev/test demo resource is enabled (B6.5, Q-24.2); it is NOT
  // hard-coded into the static path set, so a disabled demo never looks CORS-enabled.
  const extraCorsPaths = isDemoEnabled(process.env) ? new Set(['/demo/me']) : undefined;
  registerCorsPreflight(
    app.getHttpAdapter().getInstance(),
    app.get(ClientCorsService),
    extraCorsPaths,
  );

  // Admin OpenAPI JSON (`GET /openapi/admin.json`, Q-27.1): development/test only, never in
  // production (route not registered => 404). Shared helper, same as the integration bootstrap.
  registerAdminOpenApi(app, process.env);

  // Reject unknown/extra fields on all DTOs.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Close Mongo/Redis connections cleanly on SIGTERM/SIGINT.
  app.enableShutdownHooks();

  const appConfig = app.get(ConfigService).getOrThrow<AppConfig>('app');
  // Fail fast if the adapter's trustProxy (parsed pre-bootstrap) and the typed config disagree —
  // this is the sole reader of `app.trustProxy`, keeping the two parse sites honest.
  assertTrustProxyConsistent(parsedTrustProxy, appConfig.trustProxy);
  await app.listen({ port: appConfig.port, host: '0.0.0.0' });
}

void bootstrap();
