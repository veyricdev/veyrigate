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
import { AppModule } from './app.module';
import type { AppConfig } from './config/configuration';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    bufferLogs: true,
  });

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

  const { port } = app.get(ConfigService).getOrThrow<AppConfig>('app');
  await app.listen({ port, host: '0.0.0.0' });
}

void bootstrap();
