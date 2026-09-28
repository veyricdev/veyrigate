import helmet from '@fastify/helmet';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
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
  await app.register(helmet);

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
