import { Controller, Get, Query, UseFilters, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { AdminAuthError, AdminAuthErrorFilter } from '../identity/tenant-context/admin-auth.errors';
import {
  type AdminActor,
  AdminScope,
  AdminTokenGuard,
  CurrentAdmin,
  Tenant,
  type TenantContext,
} from '../identity/tenant-context/tenant-context';
import { type AuditCursor, AuditService } from '../security/audit/audit.service';
import { AuditQueryDto, DEFAULT_PAGE_LIMIT, toPage } from './admin.dto';
import { toAdminAuditEvent } from './admin.mappers';
import { AuditPageViewDto } from './admin.views';

/**
 * Opaque cursor = base64url(JSON `{t: ms epoch, i: _id as 24 lowercase hex}`) of the last event of
 * the page (run 57, DEBT-422). The pre-run-57 `{t, e: eventId}` cursor no longer decodes (400).
 */
export function encodeAuditCursor(c: AuditCursor): string {
  return Buffer.from(JSON.stringify({ t: c.timestamp.getTime(), i: c.id.toHexString() })).toString(
    'base64url',
  );
}

/** Decode + validate (anything malformed => null, the caller answers 400). */
export function decodeAuditCursor(raw: string): AuditCursor | null {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(raw)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { t, i } = parsed as Record<string, unknown>;
  // 8.64e15 ms = the JS Date range (DEBT-427): beyond it `new Date(t)` is invalid => 400, not 5xx.
  if (typeof t !== 'number' || !Number.isSafeInteger(t) || t < 0 || t > 8.64e15) return null;
  if (typeof i !== 'string' || !/^[0-9a-f]{24}$/.test(i)) return null;
  return { timestamp: new Date(t), id: new Types.ObjectId(i) };
}

/**
 * Admin API — audit log query (B6.3b). Only events of the token's tenant (events written without a
 * tenant, e.g. most OAuth/auth events today, are not visible: DEBT-140). Newest first, cursor
 * `(timestamp, _id)`. `no-store` is set by the guard.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/audit')
@UseGuards(AdminTokenGuard)
@UseFilters(AdminAuthErrorFilter)
export class AdminAuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @AdminScope('admin.read')
  @ApiOkResponse({ type: AuditPageViewDto })
  @ApiOperation({
    description: 'Exact-match filters; `[from, to)`; `after` = previous nextCursor.',
  })
  async list(
    @Tenant() ctx: TenantContext,
    @CurrentAdmin() actor: AdminActor,
    @Query() q: AuditQueryDto,
  ) {
    const cursor = q.after === undefined ? undefined : decodeAuditCursor(q.after);
    if (cursor === null) throw AdminAuthError.invalidRequest('invalid cursor');
    const from = q.from === undefined ? undefined : new Date(q.from);
    const to = q.to === undefined ? undefined : new Date(q.to);
    if (from && to && !(from.getTime() < to.getTime())) {
      throw AdminAuthError.invalidRequest('from must be before to');
    }
    const limit = q.limit ?? DEFAULT_PAGE_LIMIT;
    const rows = await this.audit.listForTenant(
      ctx,
      {
        action: q.action,
        actorId: q.actorId,
        targetType: q.targetType,
        targetId: q.targetId,
        clientId: q.clientId,
        result: q.result,
        from,
        to,
      },
      cursor,
      limit + 1,
    );
    return toPage(
      rows,
      limit,
      (r) => encodeAuditCursor({ timestamp: r.timestamp, id: r._id }),
      // Run 71 (DEBT-344): full ip/userAgent for super_admin only (roles of THIS request's token
      // membership, same rule as `assertSuperAdmin`); everyone else gets the masked view.
      (r) => toAdminAuditEvent(r, { fullPii: actor.roles.includes('super_admin') }),
    );
  }
}
