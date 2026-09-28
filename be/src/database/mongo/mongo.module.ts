import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import type { DatabaseConfig } from '../../config/configuration';
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
        return {
          uri: mongoUri,
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
  ],
  providers: [MongoService],
  exports: [MongoService],
})
export class MongoModule {}
