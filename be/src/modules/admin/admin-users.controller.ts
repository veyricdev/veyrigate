import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import { AuthenticationService } from '../authentication/authentication.service';
import { ClientService } from '../clients/client.service';
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
import { type UserTenant, UserTenantService } from '../identity/user-tenant.service';
import { ADMIN_LOCKED_UNTIL, UserService, type UserView } from '../identity/user.service';
import { ConsentService } from '../oauth/consent/consent.service';
import { RefreshTokenService } from '../oauth/token/refresh-token.service';
import { AuditAction } from '../security/audit/audit-action.enum';
import { AuditService } from '../security/audit/audit.service';
import { adminAuditBase } from './admin-audit';
import {
  ADMIN_ROLE_VALUES,
  DEFAULT_PAGE_LIMIT,
  PageQueryDto,
  toPage,
  UpdateUserRolesDto,
  UserListQueryDto,
} from './admin.dto';
import { type AdminUserView, toAdminConsent, toAdminFamily, toAdminUser } from './admin.mappers';

const OBJECT_ID_HEX = /^[0-9a-fA-F]{24}$/;
const FAMILY_ID = /^[A-Za-z0-9-]{1,128}$/;
const ADMIN_ROLES: readonly string[] = ADMIN_ROLE_VALUES;

interface Target {
  /** Canonical lowercase hex `sub` (never the raw path param: `ABC…` must equal `abc…`). */
  id: string;
  member: UserTenant;
  user: UserView;
}

/**
 * Admin API — users of the token's tenant (B6.3b, spec §9.10/§9.11). A target exists only through
 * a `UserTenant` of the token's tenant: anything else is the byte-identical 404. `User`, its lock
 * and its sessions are GLOBAL, so a tenant_admin may only lock/unlock/revoke a user that holds no
 * admin role anywhere and has no active membership elsewhere (403); super_admin is not limited.
 * Every mutation: `admin.write` + step-up + audit. `no-store` is set by the guard.
 *
 * RefreshToken and Consent carry no tenant: every family/consent read or write is restricted to
 * `clientId ∈` the clients of the token's tenant (resolved with the tenant in the query), so a
 * grant to another tenant's client is invisible and its revoke is the same 404.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/users')
@UseGuards(AdminTokenGuard)
@UseFilters(AdminAuthErrorFilter)
export class AdminUsersController {
  constructor(
    private readonly users: UserService,
    private readonly memberships: UserTenantService,
    private readonly auth: AuthenticationService,
    private readonly audit: AuditService,
    private readonly clients: ClientService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly consents: ConsentService,
  ) {}

  @Get()
  @AdminScope('admin.read')
  async list(@Tenant() ctx: TenantContext, @Query() q: UserListQueryDto) {
    if (q.after !== undefined && !OBJECT_ID_HEX.test(q.after)) {
      throw AdminAuthError.invalidRequest('invalid cursor');
    }
    let userId: string | undefined;
    if (q.email !== undefined) {
      const user = await this.users.findByEmail(q.email);
      if (!user) return { items: [], nextCursor: null };
      userId = user.sub;
    }
    const limit = q.limit ?? DEFAULT_PAGE_LIMIT;
    const rows = await this.memberships.listMembersPage(
      ctx,
      { status: q.status, userId },
      q.after,
      limit + 1,
    );
    const found = await this.users.findByIds(
      rows.slice(0, limit).map((r) => r.userId.toHexString()),
    );
    const byId = new Map(found.map((u) => [u.sub, u]));
    const now = new Date();
    const page = toPage(
      rows,
      limit,
      (r) => String(r._id),
      (r): AdminUserView | null => {
        const user = byId.get(r.userId.toHexString());
        return user ? toAdminUser(user, r, now) : null;
      },
    );
    return { items: page.items.filter((u) => u !== null), nextCursor: page.nextCursor };
  }

  @Get(':id')
  @AdminScope('admin.read')
  async get(@Tenant() ctx: TenantContext, @Param('id') rawId: string) {
    const t = await this.mustFind(ctx, rawId);
    return toAdminUser(t.user, t.member, new Date());
  }

  @Post(':id/lock')
  @AdminScope('admin.write')
  @RequireRecentAuth(5)
  @HttpCode(200)
  @ApiOperation({
    description: 'Locks until unlocked, then revokes every session + refresh family.',
  })
  async lock(
    @Tenant() ctx: TenantContext,
    @CurrentAdmin() actor: AdminActor,
    @Param('id') rawId: string,
    @Req() req: HttpRequest,
  ) {
    const t = await this.mustFind(ctx, rawId);
    if (t.id === ctx.userId) throw AdminAuthError.forbidden();
    await this.assertMayTouchAccount(ctx, actor, t.id);
    const after = await this.users.updateStatus(t.id, { lockedUntil: ADMIN_LOCKED_UNTIL });
    if (!after) throw AdminAuthError.notFound();

    // Lock first, THEN revoke: a revoke fault keeps the lock (5xx, retry is idempotent).
    const base = { ...adminAuditBase(req, ctx), targetType: 'user', targetId: t.id };
    const { sessionCount } = await this.auth.revokeAllUserCredentials(
      t.id,
      new Date(),
      (failedStep) =>
        this.audit.record({
          ...base,
          action: AuditAction.ADMIN_USER_LOCKED,
          result: 'failure',
          reason: 'revoke_failed',
          metadata: { failedStep },
        }),
    );
    // Every successful revoke is audited (DEBT-152): a retry after `revoke_failed` must not leave
    // the trail ending on the failure.
    await this.audit.record({
      ...base,
      action: AuditAction.ADMIN_USER_LOCKED,
      result: 'success',
      metadata: { count: sessionCount },
    });
    return toAdminUser(after, t.member, new Date());
  }

  @Post(':id/unlock')
  @AdminScope('admin.write')
  @RequireRecentAuth(5)
  @HttpCode(200)
  @ApiOperation({ description: 'Clears the lock and the failed-login counter; revokes nothing.' })
  async unlock(
    @Tenant() ctx: TenantContext,
    @CurrentAdmin() actor: AdminActor,
    @Param('id') rawId: string,
    @Req() req: HttpRequest,
  ) {
    const t = await this.mustFind(ctx, rawId);
    await this.assertMayTouchAccount(ctx, actor, t.id);
    const after = await this.users.resetFailedLogins(t.id);
    if (!after) throw AdminAuthError.notFound();
    if (t.user.lockedUntil != null || t.user.failedLoginCount > 0) {
      await this.audit.record({
        ...adminAuditBase(req, ctx),
        action: AuditAction.ADMIN_USER_UNLOCKED,
        targetType: 'user',
        targetId: t.id,
        result: 'success',
      });
    }
    return toAdminUser(after, t.member, new Date());
  }

  @Post(':id/sessions/revoke')
  @AdminScope('admin.write')
  @RequireRecentAuth(5)
  @HttpCode(204)
  @ApiOperation({ description: 'Ends every session and revokes every refresh family of the user.' })
  async revokeSessions(
    @Tenant() ctx: TenantContext,
    @CurrentAdmin() actor: AdminActor,
    @Param('id') rawId: string,
    @Req() req: HttpRequest,
  ): Promise<void> {
    const t = await this.mustFind(ctx, rawId);
    await this.assertMayTouchAccount(ctx, actor, t.id);
    const base = {
      ...adminAuditBase(req, ctx),
      action: AuditAction.SESSION_REVOKED,
      targetType: 'user',
      targetId: t.id,
    };
    const { sessionCount } = await this.auth.revokeAllUserCredentials(
      t.id,
      new Date(),
      (failedStep) =>
        this.audit.record({
          ...base,
          result: 'failure',
          reason: 'revoke_failed',
          metadata: { scope: 'all', failedStep },
        }),
    );
    await this.audit.record({
      ...base,
      result: 'success',
      metadata: { scope: 'all', count: sessionCount },
    });
  }

  @Patch(':id/roles')
  @AdminScope('admin.write')
  @RequireRecentAuth(5)
  @ApiOperation({
    description:
      'Replaces the admin roles of the membership. Never on yourself; granting/revoking super_admin, ' +
      'or changing a super_admin, is super_admin-only. Effective on the target’s next request.',
  })
  async setRoles(
    @Tenant() ctx: TenantContext,
    @CurrentAdmin() actor: AdminActor,
    @Param('id') rawId: string,
    @Body() dto: UpdateUserRolesDto,
    @Req() req: HttpRequest,
  ) {
    const t = await this.mustFind(ctx, rawId);
    if (t.id === ctx.userId) throw AdminAuthError.forbidden();
    const isSuper = actor.roles.includes('super_admin');
    if (!isSuper && dto.roles.includes('super_admin')) throw AdminAuthError.forbidden();
    // Non-super: "target does not hold super_admin" is part of the atomic filter (no TOCTOU).
    const before = await this.memberships.replaceRoles(
      ctx,
      t.id,
      dto.roles,
      isSuper ? undefined : 'super_admin',
    );
    if (!before) {
      if (await this.memberships.findMember(ctx, t.id)) throw AdminAuthError.forbidden();
      throw AdminAuthError.notFound();
    }
    const prev = before.roles ?? [];
    const added = dto.roles.filter((r) => !prev.includes(r));
    const removed = prev.filter((r) => !(dto.roles as string[]).includes(r));
    if (added.length || removed.length) {
      await this.audit.record({
        ...adminAuditBase(req, ctx),
        action: AuditAction.ADMIN_USER_ROLES_CHANGED,
        targetType: 'user',
        targetId: t.id,
        result: 'success',
        metadata: { addedRoles: added.join(','), removedRoles: removed.join(',') },
      });
    }
    return toAdminUser(t.user, { ...before, roles: dto.roles }, new Date());
  }

  @Get(':id/families')
  @AdminScope('admin.read')
  @ApiOperation({ description: 'Refresh-token families of the user for clients of this tenant.' })
  async listFamilies(
    @Tenant() ctx: TenantContext,
    @Param('id') rawId: string,
    @Query() q: PageQueryDto,
  ) {
    const t = await this.mustFind(ctx, rawId);
    const limit = q.limit ?? DEFAULT_PAGE_LIMIT;
    const clientIds = await this.clients.tenantClientIds(
      ctx,
      await this.refreshTokens.distinctClientIds(t.id),
    );
    const rows = await this.refreshTokens.listFamilies(
      t.id,
      clientIds,
      q.after,
      limit + 1,
      new Date(),
    );
    return toPage(rows, limit, (f) => f.familyId, toAdminFamily);
  }

  @Post(':id/families/:familyId/revoke')
  @AdminScope('admin.write')
  @RequireRecentAuth(5)
  @HttpCode(204)
  @ApiOperation({ description: 'Revokes the whole family (stamp-first, race-safe). Idempotent.' })
  async revokeFamily(
    @Tenant() ctx: TenantContext,
    @Param('id') rawId: string,
    @Param('familyId') familyId: string,
    @Req() req: HttpRequest,
  ): Promise<void> {
    const t = await this.mustFind(ctx, rawId);
    if (!FAMILY_ID.test(familyId)) throw AdminAuthError.notFound();
    const clientId = await this.refreshTokens.findFamilyClient(familyId, t.id);
    if (!clientId || !(await this.clients.getForTenant(ctx, clientId))) {
      throw AdminAuthError.notFound();
    }
    const count = await this.refreshTokens.revokeFamily(familyId, clientId, new Date());
    if (count > 0) {
      await this.audit.record({
        ...adminAuditBase(req, ctx),
        action: AuditAction.TOKEN_REVOKED,
        targetType: 'user',
        targetId: t.id,
        clientId,
        result: 'success',
        metadata: { familyId, count },
      });
    }
  }

  @Get(':id/consents')
  @AdminScope('admin.read')
  @ApiOperation({ description: 'Active consents of the user for clients of this tenant.' })
  async listConsents(
    @Tenant() ctx: TenantContext,
    @Param('id') rawId: string,
    @Query() q: PageQueryDto,
  ) {
    const t = await this.mustFind(ctx, rawId);
    if (q.after !== undefined && !OBJECT_ID_HEX.test(q.after)) {
      throw AdminAuthError.invalidRequest('invalid cursor');
    }
    const limit = q.limit ?? DEFAULT_PAGE_LIMIT;
    const clientIds = await this.clients.tenantClientIds(
      ctx,
      await this.consents.distinctClientIds(t.id),
    );
    const rows = await this.consents.listActive(t.id, clientIds, q.after, limit + 1);
    return toPage(rows, limit, (c) => c._id.toHexString(), toAdminConsent);
  }

  @Delete(':id/consents/:consentId')
  @AdminScope('admin.write')
  @RequireRecentAuth(5)
  @HttpCode(204)
  @ApiOperation({
    description:
      'Revokes the consent (the next /authorize asks again) and every refresh family of that ' +
      'user × client × resource. An already revoked consent is a 404.',
  })
  async revokeConsent(
    @Tenant() ctx: TenantContext,
    @Param('id') rawId: string,
    @Param('consentId') consentId: string,
    @Req() req: HttpRequest,
  ): Promise<void> {
    const t = await this.mustFind(ctx, rawId);
    if (!OBJECT_ID_HEX.test(consentId)) throw AdminAuthError.notFound();
    const clientIds = await this.clients.tenantClientIds(
      ctx,
      await this.consents.distinctClientIds(t.id),
    );
    const now = new Date();
    const revoked = await this.consents.revokeById(consentId, t.id, clientIds, now);
    if (!revoked) throw AdminAuthError.notFound();
    // Consent first, then its families: a refresh racing in between still dies on the family.
    const count = await this.refreshTokens.revokeForConsent(
      t.id,
      revoked.clientId,
      revoked.resource,
      now,
    );
    await this.audit.record({
      ...adminAuditBase(req, ctx),
      action: AuditAction.OAUTH_CONSENT_REVOKED,
      targetType: 'user',
      targetId: t.id,
      clientId: revoked.clientId,
      result: 'success',
      metadata: { clientId: revoked.clientId, resource: revoked.resource, count },
    });
  }

  /** Member of the token's tenant + its user, or the opaque 404 (cross-tenant == missing). */
  private async mustFind(ctx: TenantContext, rawId: string): Promise<Target> {
    if (!OBJECT_ID_HEX.test(rawId)) throw AdminAuthError.notFound();
    const member = await this.memberships.findMember(ctx, rawId);
    if (!member) throw AdminAuthError.notFound();
    const id = member.userId.toHexString();
    const user = await this.users.findById(id);
    if (!user) throw AdminAuthError.notFound();
    return { id, member, user };
  }

  /**
   * Lock, unlock and session revoke act on GLOBAL state. A non-super_admin may not touch a user
   * holding an admin role in ANY tenant, nor one with an active membership in another tenant.
   */
  private async assertMayTouchAccount(
    ctx: TenantContext,
    actor: AdminActor,
    userId: string,
  ): Promise<void> {
    if (actor.roles.includes('super_admin')) return;
    const all = await this.memberships.membershipsOf(userId);
    const privileged = all.some((m) => (m.roles ?? []).some((r) => ADMIN_ROLES.includes(r)));
    const elsewhere = all.some((m) => m.tenantId !== ctx.tenantId && m.status === 'active');
    if (privileged || elsewhere) throw AdminAuthError.forbidden();
  }
}
