import { Body, Controller, Get, HttpCode, Post, Req, UseFilters, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { HttpRequest } from '../../common/http/http.types';
import { AdminAuthError, AdminAuthErrorFilter } from '../identity/tenant-context/admin-auth.errors';
import {
  type AdminActor,
  AdminScope,
  AdminTokenGuard,
  CurrentAdmin,
  RequireRecentAuth,
  SuperAdminOnly,
  Tenant,
  type TenantContext,
} from '../identity/tenant-context/tenant-context';
import { RotationPendingError, type KeyMetadata, type RotationMode } from '../keys/key-provider';
import { KeyRotationService } from '../keys/key-rotation.service';
import { adminAuditBase } from './admin-audit';
import { assertSuperAdmin } from './admin-resources.controller';
import { RotateKeyDto } from './admin.dto';
import { KeyListViewDto, RotateKeyResultViewDto } from './admin.views';

export const ROTATION_PENDING =
  'A newer signing key is already published and does not sign yet. Wait until it activates, or use an emergency rotation.';

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
  @SuperAdminOnly()
  @ApiOperation({
    description:
      'super_admin only. Keys currently in JWKS: active (signs), pending (published, signs from ' +
      'activatesAt), retiring (verify-only until retireAt).',
  })
  @ApiOkResponse({ type: KeyListViewDto })
  async list(
    @CurrentAdmin() actor: AdminActor,
  ): Promise<{ items: KeyMetadata[]; nextCursor: null }> {
    assertSuperAdmin(actor);
    const items = (await this.rotation.list()).map(
      ({ kid, alg, status, createdAt, activatesAt, retireAt }) => ({
        kid,
        alg,
        status,
        createdAt,
        activatesAt,
        retireAt,
      }),
    );
    return { items, nextCursor: null };
  }

  @Post('rotate')
  @AdminScope('admin.write')
  @SuperAdminOnly()
  @RequireRecentAuth(5)
  @HttpCode(200)
  @ApiOperation({
    description:
      'super_admin only. normal: the new key is published at once and signs from activatesAt ' +
      '(KEY_PREPUBLISH_SEC later); the old key signs until then, then stays verify-only for ' +
      'ACCESS_TOKEN_TTL. emergency: the new key signs at once and every other key (pending ' +
      'included) leaves JWKS (sessions/refresh tokens are not revoked). Not idempotent.',
  })
  @ApiOkResponse({ type: RotateKeyResultViewDto })
  @ApiConflictResponse({
    description:
      'rotation_pending: a normal rotation while a newer key is still pending. Body ' +
      '{"error":"conflict","error_description":"A newer signing key is already published and ' +
      'does not sign yet. Wait until it activates, or use an emergency rotation."}; nothing changed.',
  })
  async rotate(
    @Tenant() ctx: TenantContext,
    @CurrentAdmin() actor: AdminActor,
    @Body() dto: RotateKeyDto,
    @Req() req: HttpRequest,
  ): Promise<{ newKid: string; oldKid: string | null; mode: RotationMode; activatesAt: string }> {
    assertSuperAdmin(actor);
    try {
      const { newKid, oldKid, mode, activatesAt } = await this.rotation.rotate(
        dto.mode,
        adminAuditBase(req, ctx),
      );
      return { newKid, oldKid, mode, activatesAt };
    } catch (err) {
      // D86.8: one fixed sentence (no kid, no time); the only 409 code of the Admin API.
      if (err instanceof RotationPendingError) throw AdminAuthError.conflict(ROTATION_PENDING);
      throw err;
    }
  }
}
