import type { ClientCredential } from '../clients/client-credential.service';
import {
  type Client,
  ConcurrentClientUpdateError,
  ForbiddenClientConfigError,
  InvalidClientConfigError,
} from '../clients/client.service';
import { InvalidRedirectUriError } from '../clients/redirect-uri.validator';
import { DuplicateError } from '../identity/identity.errors';
import type { Tenant } from '../identity/tenant.service';
import type { UserTenant } from '../identity/user-tenant.service';
import type { UserView } from '../identity/user.service';
import type { Consent } from '../oauth/consent/consent.service';
import type { FamilySummary } from '../oauth/token/refresh-token.service';
import { AdminAuthError } from '../identity/tenant-context/admin-auth.errors';
import type { Resource } from '../resources/resource.service';
import type { AuditEvent } from '../security/audit/audit.types';
import { InvalidResourceError } from '../resources/resource.validator';

/**
 * Admin API response projections (B6.3a). ALLOWLIST mappers: every output field is named here —
 * never a spread of the stored document — so `_id`, `__v`, `secretHash` or any future internal
 * field can never leak by accident.
 */

export interface AdminClientView {
  clientId: string;
  tenantId: string;
  clientType: Client['clientType'];
  tokenEndpointAuthMethod: Client['tokenEndpointAuthMethod'];
  grantTypes: Client['grantTypes'];
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  frontchannelLogoutUri: string | null;
  allowedCorsOrigins: string[];
  allowedResources: string[];
  scopes: string[];
  disabled: boolean;
  disabledAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export function toAdminClient(c: Client): AdminClientView {
  return {
    clientId: c.clientId,
    tenantId: c.tenantId,
    clientType: c.clientType,
    tokenEndpointAuthMethod: c.tokenEndpointAuthMethod,
    grantTypes: c.grantTypes ?? ['authorization_code'],
    redirectUris: c.redirectUris ?? [],
    postLogoutRedirectUris: c.postLogoutRedirectUris ?? [],
    frontchannelLogoutUri: c.frontchannelLogoutUri ?? null,
    allowedCorsOrigins: c.allowedCorsOrigins ?? [],
    allowedResources: c.allowedResources ?? [],
    scopes: c.scopes ?? [],
    disabled: c.disabledAt != null,
    disabledAt: c.disabledAt ?? null,
    createdAt: c.createdAt ?? null,
    updatedAt: c.updatedAt ?? null,
  };
}

export interface AdminResourceView {
  resourceId: string;
  identifier: string;
  scopes: string[];
}

export function toAdminResource(r: Resource): AdminResourceView {
  return { resourceId: r.resourceId, identifier: r.identifier, scopes: r.scopes ?? [] };
}

export interface AdminTenantView {
  id: string;
  name: string;
}

/** Allowlist (B6.3c): no `_id`/`__v`. */
export function toAdminTenant(t: Tenant): AdminTenantView {
  return { id: t.id, name: t.name };
}

export type CredentialStatus = 'active' | 'grace' | 'expired' | 'revoked';

export interface AdminCredentialView {
  version: number;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  status: CredentialStatus;
}

/** Credential metadata only: there is no field through which a hash or secret could flow. */
export function toAdminCredential(
  c: Omit<ClientCredential, 'secretHash'>,
  now: Date,
): AdminCredentialView {
  const expiresAt = c.expiresAt ?? null;
  const revokedAt = c.revokedAt ?? null;
  const status: CredentialStatus = revokedAt
    ? 'revoked'
    : expiresAt === null
      ? 'active'
      : expiresAt.getTime() > now.getTime()
        ? 'grace'
        : 'expired';
  return { version: c.version, createdAt: c.createdAt, expiresAt, revokedAt, status };
}

export interface AdminUserView {
  id: string;
  email: string;
  emailVerified: boolean;
  locked: boolean;
  lockedUntil: Date | null;
  membershipStatus: string;
  roles: string[];
  createdAt: Date | null;
}

/**
 * User + its membership of the token's tenant (B6.3b). Never `passwordHash`, `mfaSecret`,
 * `lockTransitionNonce`, `failedLoginCount`, profile, or any session/token field.
 */
export function toAdminUser(
  u: UserView,
  m: Pick<UserTenant, 'status' | 'roles'>,
  now: Date,
): AdminUserView {
  const lockedUntil = u.lockedUntil ?? null;
  return {
    id: u.sub,
    email: u.email,
    emailVerified: u.emailVerifiedAt != null,
    locked: lockedUntil !== null && lockedUntil.getTime() > now.getTime(),
    lockedUntil,
    membershipStatus: m.status,
    roles: [...(m.roles ?? [])],
    createdAt: u.createdAt ?? null,
  };
}

export interface AdminFamilyView {
  familyId: string;
  clientId: string;
  resource: string;
  scope: string[];
  createdAt: Date;
  lastRotatedAt: Date;
  expiresAt: Date;
  active: boolean;
  revokedAt: Date | null;
}

/** Refresh family metadata (B6.3b): never `tokenHash`, parent/successor, session or device data. */
export function toAdminFamily(f: FamilySummary): AdminFamilyView {
  return {
    familyId: f.familyId,
    clientId: f.clientId,
    resource: f.resource,
    scope: [...(f.scope ?? [])],
    createdAt: f.createdAt,
    lastRotatedAt: f.lastRotatedAt,
    expiresAt: f.expiresAt,
    active: f.active === true,
    revokedAt: f.revokedAt ?? null,
  };
}

export interface AdminConsentView {
  id: string;
  clientId: string;
  resource: string;
  grantedScopes: string[];
  policyVersion: string | null;
  termsVersion: string | null;
  grantedAt: Date;
  updatedAt: Date;
}

export function toAdminConsent(c: Consent & { _id: { toHexString(): string } }): AdminConsentView {
  return {
    id: c._id.toHexString(),
    clientId: c.clientId,
    resource: c.resource,
    grantedScopes: [...(c.grantedScopes ?? [])],
    policyVersion: c.policyVersion ?? null,
    termsVersion: c.termsVersion ?? null,
    grantedAt: c.grantedAt,
    updatedAt: c.updatedAt,
  };
}

export type AdminAuditView = Omit<AuditEvent, 'tenantId'>;

/** Audit event (B6.3b): allowlist, no `_id`; metadata was already sanitized at write (B1.7). */
export function toAdminAuditEvent(e: AuditEvent): AdminAuditView {
  return {
    eventId: e.eventId,
    timestamp: e.timestamp,
    actorType: e.actorType,
    actorId: e.actorId,
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId,
    clientId: e.clientId,
    ip: e.ip,
    userAgent: e.userAgent,
    requestId: e.requestId,
    result: e.result,
    reason: e.reason,
    metadata: e.metadata,
  };
}

/**
 * Domain error -> admin wire error (D-27.d). Anything not listed (Mongo, programming error) is
 * rethrown unchanged and becomes a 5xx (fail-closed).
 */
export function toAdminError(err: unknown): unknown {
  if (
    err instanceof InvalidRedirectUriError ||
    err instanceof InvalidClientConfigError ||
    err instanceof InvalidResourceError
  ) {
    return AdminAuthError.invalidRequest(err.message);
  }
  if (err instanceof ForbiddenClientConfigError) return AdminAuthError.forbidden();
  if (err instanceof DuplicateError) return AdminAuthError.conflict(`${err.entity} already exists`);
  if (err instanceof ConcurrentClientUpdateError) return AdminAuthError.conflict(err.message);
  return err;
}
