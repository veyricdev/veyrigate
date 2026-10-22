import { ApiProperty } from '@nestjs/swagger';
import type {
  AdminClientView,
  AdminCredentialView,
  AdminResourceView,
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
