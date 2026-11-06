import type { ModelDefinition } from '@nestjs/mongoose';
import {
  PasswordResetTokenSchema,
  EmailVerificationTokenSchema,
} from '../../modules/authentication/schemas/one-time-token.schema';
import { ClientCredentialSchema } from '../../modules/clients/schemas/client-credential.schema';
import { ClientSchema } from '../../modules/clients/schemas/client.schema';
import { FederatedIdentitySchema } from '../../modules/identity/schemas/federated-identity.schema';
import { TenantSchema } from '../../modules/identity/schemas/tenant.schema';
import { UserTenantSchema } from '../../modules/identity/schemas/user-tenant.schema';
import { UserSchema } from '../../modules/identity/schemas/user.schema';
import { ConsentSchema } from '../../modules/oauth/consent/schemas/consent.schema';
import { RefreshTokenSchema } from '../../modules/oauth/token/schemas/refresh-token.schema';
import { ResourceSchema } from '../../modules/resources/schemas/resource.schema';
import {
  createAuditLogSchema,
  DEFAULT_AUDIT_RETENTION_DAYS,
} from '../../modules/security/audit/audit-log.schema';

/**
 * Single registry of every MongoDB model (spec §10, B1.6). Used by
 * `MongoModule` (`forFeature`) and by the explicit index sync script, so the
 * two can never drift apart. `retentionDays` = `AUDIT_RETENTION_DAYS` (run 71): the AuditLog schema
 * is built fresh per call (its TTL index differs), every other schema is shared.
 */
export function buildModels(retentionDays: number): ModelDefinition[] {
  return [
    { name: 'User', schema: UserSchema },
    { name: 'FederatedIdentity', schema: FederatedIdentitySchema },
    { name: 'Tenant', schema: TenantSchema },
    { name: 'UserTenant', schema: UserTenantSchema },
    { name: 'Client', schema: ClientSchema },
    { name: 'ClientCredential', schema: ClientCredentialSchema },
    { name: 'Resource', schema: ResourceSchema },
    { name: 'Consent', schema: ConsentSchema },
    { name: 'RefreshToken', schema: RefreshTokenSchema },
    { name: 'PasswordResetToken', schema: PasswordResetTokenSchema },
    { name: 'EmailVerificationToken', schema: EmailVerificationTokenSchema },
    { name: 'AuditLog', schema: createAuditLogSchema(retentionDays) },
  ];
}

/** Models with the default retention (180 days): tests and callers without an env. */
export const MODELS: ModelDefinition[] = buildModels(DEFAULT_AUDIT_RETENTION_DAYS);
