import { Body, Controller, Get, HttpCode, Post, Req, UseFilters, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { HttpRequest } from '../../common/http/http.types';
import { AdminAuthErrorFilter } from '../identity/tenant-context/admin-auth.errors';
import {
  type AdminActor,
  AdminScope,
  AdminTokenGuard,
  CurrentAdmin,
  RequireRecentAuth,
  Tenant,
  type TenantContext,
} from '../identity/tenant-context/tenant-context';
import type { KeyMetadata, RotationMode } from '../keys/key-provider';
import { KeyRotationService } from '../keys/key-rotation.service';
import { adminAuditBase } from './admin-audit';
import { assertSuperAdmin } from './admin-resources.controller';
import { RotateKeyDto } from './admin.dto';

/**
 * Admin API — signing keys (B6.3c). Platform-level, so super_admin only for read AND rotate
 * (Q-29.1); the public half is already at `/jwks.json`. Responses carry metadata only — never
 * `n/e/d/p/q/dp/dq/qi`, a PEM or a file path.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/keys')
@UseGuards(AdminTokenGuard)
@UseFilters(AdminAuthErrorFilter)
export class AdminKeysController {
  constructor(private readonly rotation: KeyRotationService) {}

  @Get()
  @AdminScope('admin.read')
  @ApiOperation({ description: 'super_admin only. Keys currently in JWKS (active + retiring).' })
  async list(
    @CurrentAdmin() actor: AdminActor,
  ): Promise<{ items: KeyMetadata[]; nextCursor: null }> {
    assertSuperAdmin(actor);
    const items = (await this.rotation.list()).map(({ kid, alg, status, createdAt, retireAt }) => ({
      kid,
      alg,
      status,
      createdAt,
      retireAt,
    }));
    return { items, nextCursor: null };
  }

  @Post('rotate')
  @AdminScope('admin.write')
  @RequireRecentAuth(5)
  @HttpCode(200)
  @ApiOperation({
    description:
      'super_admin only. normal: old key stays verify-only for ACCESS_TOKEN_TTL. emergency: old ' +
      'key leaves JWKS at once (sessions/refresh tokens are not revoked). Not idempotent.',
  })
  async rotate(
    @Tenant() ctx: TenantContext,
    @CurrentAdmin() actor: AdminActor,
    @Body() dto: RotateKeyDto,
    @Req() req: HttpRequest,
  ): Promise<{ newKid: string; oldKid: string | null; mode: RotationMode }> {
    assertSuperAdmin(actor);
    const { newKid, oldKid, mode } = await this.rotation.rotate(dto.mode, adminAuditBase(req, ctx));
    return { newKid, oldKid, mode };
  }
}
