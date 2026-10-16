import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import type { ClientType, GrantType, TokenEndpointAuthMethod } from '../clients/client.service';
import { AuditAction } from '../security/audit/audit-action.enum';

/**
 * Admin API DTOs (B6.3a). Validated by the global `ValidationPipe({whitelist,
 * forbidNonWhitelisted, transform})`: an unknown field — notably `tenantId`, `clientId` or an
 * immutable field on PATCH — is a 400, never silently dropped. No DTO accepts a tenant (Q-27.2).
 * Domain rules (redirect URI/origin/resource) live in the services, shared by create + update.
 */

const MAX_ITEMS = 20;
const MAX_LEN = 2048;
/** A scope token: non-empty, no whitespace (RFC 6749 §3.3). */
const SCOPE_TOKEN = /^\S+$/;

/** `undefined` = field absent (skip); `null` or anything else is validated (so `null` fails). */
const IfPresent = () => ValidateIf((_o: unknown, v: unknown) => v !== undefined);

/** `?limit` (1..100, default 20) + `?after` (exclusive cursor = sort key of the last item). */
export class PageQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque cursor: `nextCursor` of the previous page.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_LEN)
  after?: string;
}

export const DEFAULT_PAGE_LIMIT = 20;

/** `{items, nextCursor}`: fetch `limit + 1` rows, the extra one only tells whether more exist. */
export function toPage<T, R>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => string,
  map: (row: T) => R,
): { items: R[]; nextCursor: string | null } {
  const page = rows.slice(0, limit);
  return {
    items: page.map(map),
    nextCursor: rows.length > limit && page.length ? cursorOf(page[page.length - 1]) : null,
  };
}

class ClientFieldsDto {
  @ApiPropertyOptional({ enum: ['authorization_code', 'refresh_token'], isArray: true })
  @IfPresent()
  @IsArray()
  @ArrayMaxSize(MAX_ITEMS)
  @IsIn(['authorization_code', 'refresh_token'], { each: true })
  grantTypes?: GrantType[];

  @ApiPropertyOptional({ type: [String], maxItems: MAX_ITEMS })
  @IfPresent()
  @IsArray()
  @ArrayMaxSize(MAX_ITEMS)
  @IsString({ each: true })
  @MaxLength(MAX_LEN, { each: true })
  redirectUris?: string[];

  @ApiPropertyOptional({ type: [String], maxItems: MAX_ITEMS })
  @IfPresent()
  @IsArray()
  @ArrayMaxSize(MAX_ITEMS)
  @IsString({ each: true })
  @MaxLength(MAX_LEN, { each: true })
  postLogoutRedirectUris?: string[];

  @ApiPropertyOptional({ type: [String], maxItems: MAX_ITEMS, description: 'Exact origins.' })
  @IfPresent()
  @IsArray()
  @ArrayMaxSize(MAX_ITEMS)
  @IsString({ each: true })
  @MaxLength(MAX_LEN, { each: true })
  allowedCorsOrigins?: string[];

  @ApiPropertyOptional({ type: [String], maxItems: MAX_ITEMS, description: 'resourceIds.' })
  @IfPresent()
  @IsArray()
  @ArrayMaxSize(MAX_ITEMS)
  @IsString({ each: true })
  @MaxLength(MAX_LEN, { each: true })
  allowedResources?: string[];

  @ApiPropertyOptional({ type: [String], maxItems: MAX_ITEMS })
  @IfPresent()
  @IsArray()
  @ArrayMaxSize(MAX_ITEMS)
  @IsString({ each: true })
  @MaxLength(MAX_LEN, { each: true })
  @Matches(SCOPE_TOKEN, { each: true })
  scopes?: string[];
}

/** `POST /admin/clients` — `clientId` is server-generated; no secret is ever issued here. */
export class CreateClientDto extends ClientFieldsDto {
  @ApiProperty({ enum: ['public', 'confidential'] })
  @IsIn(['public', 'confidential'])
  clientType!: ClientType;

  @ApiProperty({
    enum: ['none', 'client_secret_basic', 'client_secret_post'],
    description: 'public => none; confidential => client_secret_basic | client_secret_post.',
  })
  @IsIn(['none', 'client_secret_basic', 'client_secret_post'])
  tokenEndpointAuthMethod!: TokenEndpointAuthMethod;

  @ApiPropertyOptional({ maxLength: MAX_LEN })
  @IfPresent()
  @IsString()
  @MaxLength(MAX_LEN)
  frontchannelLogoutUri?: string;
}

/**
 * `PATCH /admin/clients/:clientId` — arrays replace wholesale. `clientId`, `clientType`,
 * `tokenEndpointAuthMethod`, `tenantId` are immutable: not declared, so sending them is a 400.
 */
export class UpdateClientDto extends ClientFieldsDto {
  @ApiPropertyOptional({ maxLength: MAX_LEN, nullable: true, description: 'null removes it.' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_LEN)
  frontchannelLogoutUri?: string | null;

  @ApiPropertyOptional({ description: 'true disables the client (reversible).' })
  @IfPresent()
  @IsBoolean()
  disabled?: boolean;
}

const RESOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_RESOURCE_SCOPES = 50;

/** `POST /admin/resources` (super_admin). `resourceId` + `identifier` are immutable afterwards. */
export class CreateResourceDto {
  @ApiProperty({ pattern: RESOURCE_ID.source })
  @IsString()
  @Matches(RESOURCE_ID)
  resourceId!: string;

  @ApiProperty({ maxLength: MAX_LEN, description: 'Absolute URI without fragment (the `aud`).' })
  @IsString()
  @MaxLength(MAX_LEN)
  identifier!: string;

  @ApiPropertyOptional({ type: [String], maxItems: MAX_RESOURCE_SCOPES })
  @IfPresent()
  @IsArray()
  @ArrayMaxSize(MAX_RESOURCE_SCOPES)
  @IsString({ each: true })
  @MaxLength(256, { each: true })
  @Matches(SCOPE_TOKEN, { each: true })
  scopes?: string[];
}

/** `PATCH /admin/resources/:resourceId` (super_admin) — only `scopes` (Q-27.4). */
export class UpdateResourceDto {
  @ApiProperty({ type: [String], maxItems: MAX_RESOURCE_SCOPES })
  @IsArray()
  @ArrayMaxSize(MAX_RESOURCE_SCOPES)
  @IsString({ each: true })
  @MaxLength(256, { each: true })
  @Matches(SCOPE_TOKEN, { each: true })
  scopes!: string[];
}

/** `GET /admin/users` — exact-match filters only (no regex: `User` is global, ReDoS/enumeration). */
export class UserListQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ maxLength: 320, description: 'Exact email (normalized), no pattern.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(320)
  email?: string;

  @ApiPropertyOptional({ enum: ['active', 'suspended'], description: 'Membership status.' })
  @IsOptional()
  @IsIn(['active', 'suspended'])
  status?: 'active' | 'suspended';
}

export const ADMIN_ROLE_VALUES = ['tenant_admin', 'super_admin'] as const;
export type AdminRole = (typeof ADMIN_ROLE_VALUES)[number];

/** `PATCH /admin/users/:id/roles` — replaces the admin roles of the membership wholesale. */
export class UpdateUserRolesDto {
  @ApiProperty({ enum: ADMIN_ROLE_VALUES, isArray: true, maxItems: 2, uniqueItems: true })
  @IsArray()
  @ArrayMaxSize(2)
  @ArrayUnique()
  @IsIn(ADMIN_ROLE_VALUES, { each: true })
  roles!: AdminRole[];
}

/** `GET /admin/audit` — exact-match filters, `[from, to)` ISO 8601 range, opaque cursor. */
export class AuditQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: AuditAction })
  @IsOptional()
  @IsIn(Object.values(AuditAction))
  action?: AuditAction;

  @ApiPropertyOptional({ maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  actorId?: string;

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  targetType?: string;

  @ApiPropertyOptional({ maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  targetId?: string;

  @ApiPropertyOptional({ maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  clientId?: string;

  @ApiPropertyOptional({ enum: ['success', 'failure'] })
  @IsOptional()
  @IsIn(['success', 'failure'])
  result?: 'success' | 'failure';

  @ApiPropertyOptional({ description: 'Inclusive ISO 8601 lower bound.' })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiPropertyOptional({ description: 'Exclusive ISO 8601 upper bound (must be after `from`).' })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}

/** `POST /admin/keys/rotate` (super_admin, step-up, B6.3c). `mode` is required; no query flag. */
export class RotateKeyDto {
  @ApiProperty({ enum: ['normal', 'emergency'] })
  @IsIn(['normal', 'emergency'])
  mode!: 'normal' | 'emergency';
}

/** `GET /admin/tenants` — `after` is a tenant `id` (the sort key). */
export class TenantListQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ maxLength: 128, pattern: '^[A-Za-z0-9._-]+$' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9._-]+$/)
  declare after?: string;
}
