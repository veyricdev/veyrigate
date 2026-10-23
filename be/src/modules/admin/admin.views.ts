import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { KeyMetadata, RotationMode } from '../keys/key-provider';
import { AuditAction } from '../security/audit/audit-action.enum';
import type { AuditActorType, AuditMetadata } from '../security/audit/audit.types';
import type {
  AdminAuditView,
  AdminClientView,
  AdminConsentView,
  AdminCredentialView,
  AdminFamilyView,
  AdminResourceView,
  AdminUserView,
  CredentialStatus,
} from './admin.mappers';

/**
 * OpenAPI-only response schemas (DEBT-290, Q-44.1): hand-written decorators, no swagger plugin.
 * Never instantiated — the mappers in `admin.mappers.ts` stay the runtime allowlist. Each class
 * `implements` its mapper interface (a missing field fails `tsc`); `admin.spec.ts` compares the
 * mapper keys with the schema `properties` (an extra field fails the test).
 */

const DATE = { type: String, format: 'date-time' } as const;
const NULLABLE_DATE = { ...DATE, nullable: true } as const;

export class AdminClientViewDto implements AdminClientView {
  @ApiProperty({ type: String })
  clientId!: string;

  @ApiProperty({ type: String })
  tenantId!: string;

  @ApiProperty({ enum: ['public', 'confidential'] })
  clientType!: AdminClientView['clientType'];

  @ApiProperty({ enum: ['none', 'client_secret_basic', 'client_secret_post'] })
  tokenEndpointAuthMethod!: AdminClientView['tokenEndpointAuthMethod'];

  @ApiProperty({ enum: ['authorization_code', 'refresh_token'], isArray: true })
  grantTypes!: AdminClientView['grantTypes'];

  @ApiProperty({ type: [String] })
  redirectUris!: string[];

  @ApiProperty({ type: [String] })
  postLogoutRedirectUris!: string[];

  @ApiProperty({ type: String, nullable: true })
  frontchannelLogoutUri!: string | null;

  @ApiProperty({ type: [String] })
  allowedCorsOrigins!: string[];

  @ApiProperty({ type: [String] })
  allowedResources!: string[];

  @ApiProperty({ type: [String] })
  scopes!: string[];

  @ApiProperty({ type: Boolean })
  disabled!: boolean;

  @ApiProperty(NULLABLE_DATE)
  disabledAt!: Date | null;

  @ApiProperty(NULLABLE_DATE)
  createdAt!: Date | null;

  @ApiProperty(NULLABLE_DATE)
  updatedAt!: Date | null;
}

export class ClientPageViewDto {
  @ApiProperty({ type: [AdminClientViewDto] })
  items!: AdminClientViewDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class AdminCredentialViewDto implements AdminCredentialView {
  @ApiProperty({ type: 'integer' })
  version!: number;

  @ApiProperty(DATE)
  createdAt!: Date;

  @ApiProperty(NULLABLE_DATE)
  expiresAt!: Date | null;

  @ApiProperty(NULLABLE_DATE)
  revokedAt!: Date | null;

  @ApiProperty({ enum: ['active', 'grace', 'expired', 'revoked'] })
  status!: CredentialStatus;
}

export class CredentialListViewDto {
  @ApiProperty({ type: [AdminCredentialViewDto] })
  items!: AdminCredentialViewDto[];
}

export class IssuedSecretViewDto {
  @ApiProperty({ type: String })
  clientId!: string;

  @ApiProperty({ type: 'integer' })
  version!: number;

  @ApiProperty({ type: String, description: 'Plaintext, returned ONLY in this response.' })
  clientSecret!: string;
}

export class AdminResourceViewDto implements AdminResourceView {
  @ApiProperty({ type: String })
  resourceId!: string;

  @ApiProperty({ type: String })
  identifier!: string;

  @ApiProperty({ type: [String] })
  scopes!: string[];
}

export class ResourcePageViewDto {
  @ApiProperty({ type: [AdminResourceViewDto] })
  items!: AdminResourceViewDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class AdminUserViewDto implements AdminUserView {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  email!: string;

  @ApiProperty({ type: Boolean })
  emailVerified!: boolean;

  @ApiProperty({ type: Boolean })
  locked!: boolean;

  @ApiProperty(NULLABLE_DATE)
  lockedUntil!: Date | null;

  @ApiProperty({ enum: ['active', 'suspended'] })
  membershipStatus!: string;

  @ApiProperty({ type: [String] })
  roles!: string[];

  @ApiProperty(NULLABLE_DATE)
  createdAt!: Date | null;
}

export class UserPageViewDto {
  @ApiProperty({ type: [AdminUserViewDto] })
  items!: AdminUserViewDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class AdminFamilyViewDto implements AdminFamilyView {
  @ApiProperty({ type: String })
  familyId!: string;

  @ApiProperty({ type: String })
  clientId!: string;

  @ApiProperty({ type: String })
  resource!: string;

  @ApiProperty({ type: [String] })
  scope!: string[];

  @ApiProperty(DATE)
  createdAt!: Date;

  @ApiProperty(DATE)
  lastRotatedAt!: Date;

  @ApiProperty(DATE)
  expiresAt!: Date;

  @ApiProperty({ type: Boolean })
  active!: boolean;

  @ApiProperty(NULLABLE_DATE)
  revokedAt!: Date | null;
}

export class FamilyPageViewDto {
  @ApiProperty({ type: [AdminFamilyViewDto] })
  items!: AdminFamilyViewDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class AdminConsentViewDto implements AdminConsentView {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  clientId!: string;

  @ApiProperty({ type: String })
  resource!: string;

  @ApiProperty({ type: [String] })
  grantedScopes!: string[];

  @ApiProperty({ type: String, nullable: true })
  policyVersion!: string | null;

  @ApiProperty({ type: String, nullable: true })
  termsVersion!: string | null;

  @ApiProperty(DATE)
  grantedAt!: Date;

  @ApiProperty(DATE)
  updatedAt!: Date;
}

export class ConsentPageViewDto {
  @ApiProperty({ type: [AdminConsentViewDto] })
  items!: AdminConsentViewDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

/** Optional fields are omitted from the JSON when absent (never `null`). */
export class AdminAuditEventViewDto implements AdminAuditView {
  @ApiProperty({ type: String })
  eventId!: string;

  @ApiProperty(DATE)
  timestamp!: Date;

  @ApiProperty({ enum: ['user', 'client', 'admin', 'system'] })
  actorType!: AuditActorType;

  @ApiPropertyOptional({ type: String })
  actorId?: string;

  @ApiProperty({ enum: AuditAction })
  action!: AuditAction;

  @ApiPropertyOptional({ type: String })
  targetType?: string;

  @ApiPropertyOptional({ type: String })
  targetId?: string;

  @ApiPropertyOptional({ type: String })
  clientId?: string;

  @ApiPropertyOptional({ type: String })
  ip?: string;

  @ApiPropertyOptional({ type: String })
  userAgent?: string;

  @ApiPropertyOptional({ type: String })
  requestId?: string;

  @ApiProperty({ enum: ['success', 'failure'] })
  result!: 'success' | 'failure';

  @ApiPropertyOptional({ type: String })
  reason?: string;

  @ApiPropertyOptional({
    type: 'object',
    description: 'Flat, primitive-only; sanitized at write (INV-20).',
    additionalProperties: {
      oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
      nullable: true,
    },
  })
  metadata?: AuditMetadata;
}

export class AuditPageViewDto {
  @ApiProperty({ type: [AdminAuditEventViewDto] })
  items!: AdminAuditEventViewDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

/** Signing key metadata (B6.3c) — the controller's allowlist; never key material. */
export class AdminKeyViewDto implements KeyMetadata {
  @ApiProperty({ type: String })
  kid!: string;

  @ApiProperty({ enum: ['RS256'] })
  alg!: KeyMetadata['alg'];

  @ApiProperty({ enum: ['active', 'retiring'] })
  status!: KeyMetadata['status'];

  @ApiProperty(DATE)
  createdAt!: string;

  @ApiProperty(NULLABLE_DATE)
  retireAt!: string | null;
}

/** `nextCursor` is always `null` (every key in JWKS fits one page); kept for the page shape. */
export class KeyListViewDto {
  @ApiProperty({ type: [AdminKeyViewDto] })
  items!: AdminKeyViewDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class RotateKeyResultViewDto {
  @ApiProperty({ type: String })
  newKid!: string;

  @ApiProperty({ type: String, nullable: true })
  oldKid!: string | null;

  @ApiProperty({ enum: ['normal', 'emergency'] })
  mode!: RotationMode;
}
