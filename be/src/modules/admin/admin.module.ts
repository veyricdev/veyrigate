import { Module } from '@nestjs/common';
import { ClientsModule } from '../clients/clients.module';
import { IdentityModule } from '../identity/identity.module';
import { KeysModule } from '../keys/keys.module';
import { ResourcesModule } from '../resources/resources.module';
import { AdminController } from './admin.controller';

/** Admin API (B6.1+). Mounted in every environment: read-only for now and always guarded. */
@Module({
  imports: [IdentityModule, ClientsModule, KeysModule, ResourcesModule],
  controllers: [AdminController],
})
export class AdminModule {}
