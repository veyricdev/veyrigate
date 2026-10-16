import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { HttpRequest } from '../../common/http/http.types';
import { AdminAuthError, AdminAuthErrorFilter } from '../identity/tenant-context/admin-auth.errors';
import {
  type AdminActor,
  AdminScope,
  AdminTokenGuard,
  CurrentAdmin,
  RequireRecentAuth,
  Tenant,
  type TenantContext,
} from '../identity/tenant-context/tenant-context';
import { ResourceService } from '../resources/resource.service';
import { AuditAction } from '../security/audit/audit-action.enum';
import { AuditService } from '../security/audit/audit.service';
import { adminAuditBase } from './admin-audit';
import {
  CreateResourceDto,
  DEFAULT_PAGE_LIMIT,
  PageQueryDto,
  toPage,
  UpdateResourceDto,
} from './admin.dto';
import { toAdminError, toAdminResource } from './admin.mappers';

/**
 * Admin API — resources (B6.3a). Resources are GLOBAL (spec §10, no `tenantId`): every admin may
 * read them (to pick `allowedResources`); only a `super_admin` may write, with step-up. `resourceId`
 * and `identifier` are immutable (Q-27.4): PATCH changes `scopes` only.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/resources')
@UseGuards(AdminTokenGuard)
@UseFilters(AdminAuthErrorFilter)
export class AdminResourcesController {
  constructor(
    private readonly resources: ResourceService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @AdminScope('admin.read')
  async list(@Query() q: PageQueryDto) {
    const limit = q.limit ?? DEFAULT_PAGE_LIMIT;
    const rows = await this.resources.list(q.after, limit + 1);
    return toPage(rows, limit, (r) => r.identifier, toAdminResource);
  }

  @Get(':resourceId')
  @AdminScope('admin.read')
  async get(@Param('resourceId') resourceId: string) {
    const resource = await this.resources.findByResourceId(resourceId);
    if (!resource) throw AdminAuthError.notFound();
    return toAdminResource(resource);
  }

  @Post()
  @AdminScope('admin.write')
  @RequireRecentAuth(5)
  @ApiOperation({ description: 'super_admin only. resourceId and identifier are immutable.' })
  async create(
    @Tenant() ctx: TenantContext,
    @CurrentAdmin() actor: AdminActor,
    @Body() dto: CreateResourceDto,
    @Req() req: HttpRequest,
  ) {
    assertSuperAdmin(actor);
    const resource = await this.resources.createUnique(dto).catch((err: unknown) => {
      throw toAdminError(err);
    });
    await this.audit.record({
      ...adminAuditBase(req, ctx),
      action: AuditAction.ADMIN_RESOURCE_CREATED,
      targetType: 'resource',
      targetId: resource.resourceId,
      result: 'success',
      metadata: { identifier: resource.identifier, scopeCount: resource.scopes.length },
    });
    return toAdminResource(resource);
  }

  @Patch(':resourceId')
  @AdminScope('admin.write')
  @RequireRecentAuth(5)
  @ApiOperation({ description: 'super_admin only. Only `scopes` can change.' })
  async update(
    @Tenant() ctx: TenantContext,
    @CurrentAdmin() actor: AdminActor,
    @Param('resourceId') resourceId: string,
    @Body() dto: UpdateResourceDto,
    @Req() req: HttpRequest,
  ) {
    assertSuperAdmin(actor);
    const res = await this.resources.updateScopes(resourceId, dto.scopes);
    if (!res) throw AdminAuthError.notFound();
    const before = res.before.scopes ?? [];
    await this.audit.record({
      ...adminAuditBase(req, ctx),
      action: AuditAction.ADMIN_RESOURCE_UPDATED,
      targetType: 'resource',
      targetId: resourceId,
      result: 'success',
      metadata: {
        changedFields: 'scopes',
        scopesAdded: dto.scopes.filter((s) => !before.includes(s)).length,
        scopesRemoved: before.filter((s) => !dto.scopes.includes(s)).length,
      },
    });
    return toAdminResource(res.after);
  }
}

/** Resources are global: writing one affects every tenant, so tenant_admin may not (Q-27.2). */
function assertSuperAdmin(actor: AdminActor): void {
  if (!actor.roles.includes('super_admin')) throw AdminAuthError.forbidden();
}
