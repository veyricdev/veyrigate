import { Module } from '@nestjs/common';
import { AuthenticationModule } from '../authentication/authentication.module';
import { ClientsModule } from '../clients/clients.module';
import { IdentityModule } from '../identity/identity.module';
import { KeysModule } from '../keys/keys.module';
import { OauthModule } from '../oauth/oauth.module';
import { ResourcesModule } from '../resources/resources.module';
import { AdminAuditController } from './admin-audit.controller';
import { AdminClientsController } from './admin-clients.controller';
import { AdminResourcesController } from './admin-resources.controller';
import { AdminUsersController } from './admin-users.controller';
import { AdminController } from './admin.controller';

/**
 * Admin API (B6.1+, B6.3a, B6.3b). Mounted in every environment and always guarded (admin bearer token,
 * every mutation step-up). The OpenAPI JSON is served only outside production (`admin.openapi.ts`).
 */
@Module({
  imports: [
    IdentityModule,
    ClientsModule,
    KeysModule,
    ResourcesModule,
    OauthModule,
    AuthenticationModule,
  ],
  controllers: [
    AdminController,
    AdminClientsController,
    AdminResourcesController,
    AdminUsersController,
    AdminAuditController,
  ],
})
export class AdminModule {}
