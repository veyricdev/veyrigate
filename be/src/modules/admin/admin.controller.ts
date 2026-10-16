import { Controller, Get, UseFilters, UseGuards } from '@nestjs/common';
import { AdminAuthErrorFilter } from '../identity/tenant-context/admin-auth.errors';
import {
  AdminRoles,
  AdminScope,
  AdminTokenGuard,
  Tenant,
  type TenantContext,
} from '../identity/tenant-context/tenant-context';

/**
 * Admin API (control plane, spec §9.11). B6.1 only proves the guard with a read-only endpoint;
 * the real admin endpoints arrive in B6.3. Bearer token for the `admin` resource only, no CORS
 * (fe-admin is a BFF, server-to-server), `no-store` (set by the guard on every response).
 */
@Controller('admin')
@UseGuards(AdminTokenGuard)
@UseFilters(AdminAuthErrorFilter)
export class AdminController {
  /** `GET /admin/me` -> `{sub, tenantId, roles}` (never `sid`, never the token). */
  @Get('me')
  @AdminScope('admin.read')
  me(@Tenant() ctx: TenantContext, @AdminRoles() roles: readonly string[]) {
    return { sub: ctx.userId, tenantId: ctx.tenantId, roles };
  }
}
