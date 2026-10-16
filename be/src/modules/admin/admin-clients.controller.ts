import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
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
import { ClientCredentialService } from '../clients/client-credential.service';
import { type Client, ClientService } from '../clients/client.service';
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
import { AuditAction } from '../security/audit/audit-action.enum';
import { AuditService } from '../security/audit/audit.service';
import type { AuditMetadata } from '../security/audit/audit.types';
import { adminAuditBase } from './admin-audit';
import {
  CreateClientDto,
  DEFAULT_PAGE_LIMIT,
  PageQueryDto,
  toPage,
  UpdateClientDto,
} from './admin.dto';
import { toAdminClient, toAdminCredential, toAdminError } from './admin.mappers';

const REDIRECT_FIELDS = [
  'redirectUris',
  'postLogoutRedirectUris',
  'frontchannelLogoutUri',
] as const;
const DIFF_FIELDS = [
  'grantTypes',
  ...REDIRECT_FIELDS,
  'allowedCorsOrigins',
  'allowedResources',
  'scopes',
] as const;

/**
 * Admin API — clients + client secrets (B6.3a, spec §9.10/§9.11). Tenant = the admin token's
 * tenant ONLY (Q-27.2): every lookup is `{clientId, tenantId}` in one filter, so another tenant's
 * client is a byte-identical 404 (D-27.c). Every mutation needs `admin.write` + a recent login
 * (D-27.a) and is audited after it succeeds (D-27.e). `no-store` is set by the guard.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/clients')
@UseGuards(AdminTokenGuard)
@UseFilters(AdminAuthErrorFilter)
export class AdminClientsController {
  constructor(
    private readonly clients: ClientService,
    private readonly credentials: ClientCredentialService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @AdminScope('admin.read')
  async list(@Tenant() ctx: TenantContext, @Query() q: PageQueryDto) {
    const limit = q.limit ?? DEFAULT_PAGE_LIMIT;
    const rows = await this.clients.listForTenant(ctx, q.after, limit + 1);
    return toPage(rows, limit, (c) => c.clientId, toAdminClient);
  }

  @Get(':clientId')
  @AdminScope('admin.read')
  async get(@Tenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return toAdminClient(await this.mustFind(ctx, clientId));
  }

  @Post()
  @AdminScope('admin.write')
  @RequireRecentAuth(5)
  @ApiOperation({ description: 'Never issues a secret: use POST /admin/clients/{id}/secrets.' })
  async create(
    @Tenant() ctx: TenantContext,
    @CurrentAdmin() actor: AdminActor,
    @Body() dto: CreateClientDto,
    @Req() req: HttpRequest,
  ) {
    const client = await this.clients.createForTenant(ctx, dto, actor).catch((err: unknown) => {
      throw toAdminError(err);
    });
    await this.audit.record({
      ...adminAuditBase(req, ctx),
      action: AuditAction.ADMIN_CLIENT_CREATED,
      targetType: 'client',
      targetId: client.clientId,
      clientId: client.clientId,
      result: 'success',
      metadata: { clientType: client.clientType },
    });
    return toAdminClient(client);
  }

  @Patch(':clientId')
  @AdminScope('admin.write')
  @RequireRecentAuth(5)
  async update(
    @Tenant() ctx: TenantContext,
    @CurrentAdmin() actor: AdminActor,
    @Param('clientId') clientId: string,
    @Body() dto: UpdateClientDto,
    @Req() req: HttpRequest,
  ) {
    if (Object.values(dto).every((v) => v === undefined)) {
      throw AdminAuthError.invalidRequest('empty update');
    }
    if (dto.disabled === true && clientId === actor.clientId) {
      // Disabling the client that issued this admin token would lock the caller out of the API.
      throw AdminAuthError.conflict('cannot disable the client issuing this admin token');
    }
    const res = await this.clients
      .updateForTenant(ctx, clientId, dto, actor)
      .catch((err: unknown) => {
        throw toAdminError(err);
      });
    if (!res) throw AdminAuthError.notFound();

    const base = {
      ...adminAuditBase(req, ctx),
      targetType: 'client',
      targetId: clientId,
      clientId,
    };
    const changed = DIFF_FIELDS.filter((f) => !sameValue(res.before[f], res.after[f]));
    const wasDisabled = res.before.disabledAt != null;
    const metadata: AuditMetadata = {
      changedFields: changed.join(','),
      ...listDelta('redirectUris', res.before.redirectUris, res.after.redirectUris),
      ...(dto.disabled !== undefined && dto.disabled !== wasDisabled
        ? { disabled: dto.disabled }
        : {}),
    };
    await this.audit.record({
      ...base,
      action: AuditAction.ADMIN_CLIENT_UPDATED,
      result: 'success',
      metadata,
    });
    const redirectChanged = REDIRECT_FIELDS.filter((f) => changed.includes(f));
    if (redirectChanged.length) {
      await this.audit.record({
        ...base,
        action: AuditAction.REDIRECT_URI_CHANGED,
        result: 'success',
        metadata: {
          changedFields: redirectChanged.join(','),
          ...listDelta('redirectUris', res.before.redirectUris, res.after.redirectUris),
          ...listDelta(
            'postLogoutRedirectUris',
            res.before.postLogoutRedirectUris,
            res.after.postLogoutRedirectUris,
          ),
        },
      });
    }
    return toAdminClient(res.after);
  }

  @Get(':clientId/secrets')
  @AdminScope('admin.read')
  @ApiOperation({ description: 'Credential metadata only; a secret is never readable again.' })
  async listSecrets(@Tenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    const client = await this.mustFind(ctx, clientId);
    const now = new Date();
    const rows = await this.credentials.listMetadata(client.clientId);
    return { items: rows.map((c) => toAdminCredential(c, now)) };
  }

  @Post(':clientId/secrets')
  @AdminScope('admin.write')
  @RequireRecentAuth(5)
  @Header('Pragma', 'no-cache')
  @ApiOperation({
    description:
      'Creates the first secret, or rotates (previous versions stay valid for CLIENT_SECRET_GRACE_TTL). ' +
      'The plaintext `clientSecret` is returned ONLY in this response.',
  })
  async issueSecret(
    @Tenant() ctx: TenantContext,
    @CurrentAdmin() actor: AdminActor,
    @Param('clientId') clientId: string,
    @Req() req: HttpRequest,
  ) {
    const client = await this.mustModify(ctx, clientId, actor);
    if (client.clientType !== 'confidential') {
      throw AdminAuthError.invalidRequest('a public client has no secret');
    }
    // Always rotate (== create when nothing is active): two concurrent first POSTs leave exactly
    // one version without expiry (DEBT-133). `hasActive` only names the audit action.
    const rotate = await this.credentials.hasActive(client.clientId);
    const issued = await this.credentials.rotateSecret(client.clientId);
    // Audit BEFORE returning: if it fails the request is a 5xx and the plaintext is never sent
    // (DEBT-129). The secret itself never enters the audit/log.
    await this.audit.record({
      ...adminAuditBase(req, ctx),
      action: rotate ? AuditAction.CLIENT_SECRET_ROTATED : AuditAction.CLIENT_SECRET_CREATED,
      targetType: 'client',
      targetId: client.clientId,
      clientId: client.clientId,
      result: 'success',
      metadata: { version: issued.version },
    });
    return { clientId: client.clientId, version: issued.version, clientSecret: issued.secret };
  }

  @Delete(':clientId/secrets/:version')
  @AdminScope('admin.write')
  @RequireRecentAuth(5)
  @HttpCode(204)
  @ApiOperation({
    description:
      'Revokes this secret version immediately (no grace). Tokens already issued are NOT revoked.',
  })
  async revokeSecret(
    @Tenant() ctx: TenantContext,
    @CurrentAdmin() actor: AdminActor,
    @Param('clientId') clientId: string,
    @Param('version') rawVersion: string,
    @Req() req: HttpRequest,
  ): Promise<void> {
    if (!/^[1-9][0-9]{0,8}$/.test(rawVersion)) {
      throw AdminAuthError.invalidRequest('version must be a positive integer');
    }
    const version = Number(rawVersion);
    const client = await this.mustModify(ctx, clientId, actor);
    if (!(await this.credentials.revokeSecret(client.clientId, version))) {
      throw AdminAuthError.notFound();
    }
    await this.audit.record({
      ...adminAuditBase(req, ctx),
      action: AuditAction.CLIENT_SECRET_REVOKED,
      targetType: 'client',
      targetId: client.clientId,
      clientId: client.clientId,
      result: 'success',
      metadata: { version },
    });
  }

  /** `mustFind` + the actor may write it (admin-capable client => super_admin only, else 403). */
  private async mustModify(ctx: TenantContext, clientId: string, actor: AdminActor) {
    const client = await this.mustFind(ctx, clientId);
    await this.clients.assertMayModify(client, actor).catch((err: unknown) => {
      throw toAdminError(err);
    });
    return client;
  }

  /** Client of the token's tenant, or the opaque 404 (cross-tenant == missing, D-27.c). */
  private async mustFind(ctx: TenantContext, clientId: string): Promise<Client> {
    const client = await this.clients.getForTenant(ctx, clientId);
    if (!client) throw AdminAuthError.notFound();
    return client;
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** `{<field>Added: n, <field>Removed: n}` (counts only: the audit trail carries no URI list). */
function listDelta(
  field: string,
  before: readonly string[] = [],
  after: readonly string[] = [],
): Record<string, number> {
  if (sameValue(before, after)) return {};
  return {
    [`${field}Added`]: after.filter((u) => !before.includes(u)).length,
    [`${field}Removed`]: before.filter((u) => !after.includes(u)).length,
  };
}
