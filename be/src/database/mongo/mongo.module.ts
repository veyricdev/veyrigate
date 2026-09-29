import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import type { AppConfig, DatabaseConfig } from '../../config/configuration';
import { MODELS } from './models';
import { MongoService } from './mongo.service';

/**
 * MongoDB (Mongoose) connection module (B1.4).
 *
 * Connects using `database.mongoUri`. Mongoose retries the initial connection
 * and auto-reconnects on drop; `serverSelectionTimeoutMS` bounds how long a
 * command waits for a reachable server. The connection is closed cleanly on
 * shutdown via Nest's shutdown hooks (enabled in `main.ts`).
 */
@Global()
@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const logger = new Logger('MongoClient');
        const { mongoUri } = config.getOrThrow<DatabaseConfig>('database');
        const { nodeEnv } = config.getOrThrow<AppConfig>('app');
        return {
          uri: mongoUri,
          // B1.6: never build indexes implicitly in prod — run `db:sync-indexes`.
          autoIndex: nodeEnv !== 'production',
          serverSelectionTimeoutMS: 5000,
          retryAttempts: 5,
          retryDelay: 1000,
          connectionFactory: (connection: import('mongoose').Connection) => {
            connection.on('connected', () => logger.log('Mongo connected'));
            connection.on('error', (err: Error) => logger.error(`Mongo error: ${err.message}`));
            connection.on('disconnected', () => logger.warn('Mongo disconnected'));
            return connection;
          },
        };
      },
    }),
    MongooseModule.forFeature(MODELS),
  ],
  providers: [MongoService],
  exports: [MongoService, MongooseModule],
})
export class MongoModule {}
