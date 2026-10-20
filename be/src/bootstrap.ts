import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import view from '@fastify/view';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { Eta } from 'eta';
import { join } from 'node:path';
import { registerMetrics } from './common/metrics/metrics.http';
import type { MetricsConfig } from './config/configuration';
import { ClientCorsService } from './modules/clients/client-cors.service';
import { registerCorsPreflight } from './modules/clients/client-cors.helper';
import { isDemoEnabled } from './modules/demo/demo.enabled';
import { registerAdminOpenApi } from './modules/admin/admin.openapi';

/**
 * Everything the HTTP app needs after it is created (F17, run 33): logger, security headers,
 * cookies, static assets, views, CORS preflight, admin OpenAPI, validation, shutdown hooks. Shared
 * by `main.ts` and the E2E entry (`test/e2e/e2e-main.ts`) so both run the exact same wiring.
 */
export async function configureApp(app: NestFastifyApplication): Promise<void> {
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
  // `dotfiles: 'ignore'` (404): @fastify/static 10 defaults to 'allow' (B7.4, run 38).
  await app.register(fastifyStatic, {
    root: join(__dirname, 'public'),
    prefix: '/assets/',
    dotfiles: 'ignore',
  });
  await app.register(view, {
    engine: { eta: new Eta({ views: join(__dirname, 'views'), autoEscape: true }) },
    root: join(__dirname, 'views'),
    layout: 'layout.eta',
  });

  // Prometheus (B7.2): latency hook for every route + `GET /metrics` only when METRICS_TOKEN is
  // set. Shared with the integration test (same code under test); runs before Nest adds routes.
  registerMetrics(app.getHttpAdapter().getInstance(), {
    token: app.get(ConfigService).get<MetricsConfig>('metrics')?.token,
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
}
