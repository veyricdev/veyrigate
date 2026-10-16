import { Controller, Get, Query, UseFilters, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminAuthErrorFilter } from '../identity/tenant-context/admin-auth.errors';
import {
  type AdminActor,
  AdminScope,
  AdminTokenGuard,
  CurrentAdmin,
  Tenant,
  type TenantContext,
} from '../identity/tenant-context/tenant-context';
import { TenantService } from '../identity/tenant.service';
import { DEFAULT_PAGE_LIMIT, TenantListQueryDto, toPage } from './admin.dto';
import { type AdminTenantView, toAdminTenant } from './admin.mappers';

/**
 * Admin API — tenants (B6.3c, read-only). tenant_admin sees only the token's tenant; super_admin
 * sees every tenant, paginated by `id`.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/tenants')
@UseGuards(AdminTokenGuard)
@UseFilters(AdminAuthErrorFilter)
export class AdminTenantsController {
  constructor(private readonly tenants: TenantService) {}

  @Get()
  @AdminScope('admin.read')
  @ApiOperation({ description: 'tenant_admin: own tenant only. super_admin: all tenants.' })
  async list(
    @Tenant() ctx: TenantContext,
    @CurrentAdmin() actor: AdminActor,
    @Query() q: TenantListQueryDto,
  ): Promise<{ items: AdminTenantView[]; nextCursor: string | null }> {
    if (!actor.roles.includes('super_admin')) {
      const own = await this.tenants.findById(ctx.tenantId);
      return { items: own ? [toAdminTenant(own)] : [], nextCursor: null };
    }
    const limit = q.limit ?? DEFAULT_PAGE_LIMIT;
    const rows = await this.tenants.list(q.after, limit + 1);
    return toPage(rows, limit, (t) => t.id, toAdminTenant);
  }
}
