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
import { OauthModule } from './modules/oauth/oauth.module';
import { ConditionalModule } from '@nestjs/config';
import { DemoModule } from './modules/demo/demo.module';
import { isDemoEnabled } from './modules/demo/demo.enabled';

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
    OauthModule,
    // Dev/test-only demo resource (`GET /demo/me`, B6.5). Loaded ONLY when `isDemoEnabled` (raw
    // `NODE_ENV` allowlist: development|test); absent/production => the module (and route) do not
    // exist at all, so the route 404s (Q-24.2 / DEBT-098).
    ConditionalModule.registerWhen(DemoModule, (env) => isDemoEnabled(env)),
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: OAuthExceptionFilter,
    },
  ],
})
export class AppModule {}
