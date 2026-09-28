import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from './config/config.module';
import { LoggerModule } from './common/logger/logger.module';
import { OAuthExceptionFilter } from './common/filters/oauth-exception.filter';
import { MongoModule } from './database/mongo/mongo.module';
import { RedisModule } from './database/redis/redis.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [ConfigModule, LoggerModule, MongoModule, RedisModule, HealthModule],
  providers: [
    {
      provide: APP_FILTER,
      useClass: OAuthExceptionFilter,
    },
  ],
})
export class AppModule {}
