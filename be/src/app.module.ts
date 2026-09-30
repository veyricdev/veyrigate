import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from './config/config.module';
import { LoggerModule } from './common/logger/logger.module';
import { OAuthExceptionFilter } from './common/filters/oauth-exception.filter';
import { MongoModule } from './database/mongo/mongo.module';
import { RedisModule } from './database/redis/redis.module';
import { HealthModule } from './modules/health/health.module';
import { IdentityModule } from './modules/identity/identity.module';
import { KeysModule } from './modules/keys/keys.module';
import { MailerModule } from './modules/mailer/mailer.module';
import { SecurityModule } from './modules/security/security.module';
import { AuthenticationModule } from './modules/authentication/authentication.module';
import { UiModule } from './modules/ui/ui.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    MongoModule,
    RedisModule,
    HealthModule,
    SecurityModule,
    KeysModule,
    MailerModule,
    IdentityModule,
    AuthenticationModule,
    UiModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: OAuthExceptionFilter,
    },
  ],
})
export class AppModule {}
