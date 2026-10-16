import { Module } from '@nestjs/common';
import { ClientsModule } from '../clients/clients.module';
import { IdentityModule } from '../identity/identity.module';
import { KeysModule } from '../keys/keys.module';
import { ResourcesModule } from '../resources/resources.module';
import { AdminClientsController } from './admin-clients.controller';
import { AdminResourcesController } from './admin-resources.controller';
import { AdminController } from './admin.controller';

/**
 * Admin API (B6.1+, B6.3a). Mounted in every environment and always guarded (admin bearer token,
 * every mutation step-up). The OpenAPI JSON is served only outside production (`admin.openapi.ts`).
 */
@Module({
  imports: [IdentityModule, ClientsModule, KeysModule, ResourcesModule],
  controllers: [AdminController, AdminClientsController, AdminResourcesController],
})
export class AdminModule {}
