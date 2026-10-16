import { Module } from '@nestjs/common';
import { ClientsModule } from '../clients/clients.module';
import { KeysModule } from '../keys/keys.module';
import { ResourcesModule } from '../resources/resources.module';
import { SessionsModule } from '../sessions/sessions.module';
import { DemoController } from './demo.controller';

/**
 * Dev/test-only demo resource server (`GET /demo/me`, B6.5). Mounted conditionally by `AppModule`
 * via `ConditionalModule.registerWhen(DemoModule, isDemoEnabled)` so it never exists in production.
 * The User model is available globally (`MongoModule` is `@Global`); the services are pulled from
 * the feature modules it imports. No new providers — the controller reuses the shared verification
 * + liveness gate so it cannot drift from `/userinfo`.
 */
@Module({
  imports: [ClientsModule, KeysModule, SessionsModule, ResourcesModule],
  controllers: [DemoController],
})
export class DemoModule {}
