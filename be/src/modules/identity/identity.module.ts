import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { FederatedIdentityService } from './federated-identity.service';
import { SuperAdminGuard } from './super-admin-guard';
import { TenantGuard } from './tenant-context/tenant-context';
import { TenantService } from './tenant.service';
import { UserTenantService } from './user-tenant.service';
import { UserService } from './user.service';

/** Identity (B2.1–B2.2): users, tenants, memberships, federated identities, tenant context. */
@Module({
  imports: [SessionsModule],
  providers: [
    TenantService,
    UserService,
    UserTenantService,
    SuperAdminGuard,
    FederatedIdentityService,
    TenantGuard,
  ],
  exports: [
    SessionsModule,
    TenantService,
    UserService,
    UserTenantService,
    SuperAdminGuard,
    FederatedIdentityService,
    TenantGuard,
  ],
})
export class IdentityModule {}
