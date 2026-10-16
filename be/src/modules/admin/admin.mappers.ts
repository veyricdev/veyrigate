import type { ClientCredential } from '../clients/client-credential.service';
import {
  type Client,
  ForbiddenClientConfigError,
  InvalidClientConfigError,
} from '../clients/client.service';
import { InvalidRedirectUriError } from '../clients/redirect-uri.validator';
import { DuplicateError } from '../identity/identity.errors';
import { AdminAuthError } from '../identity/tenant-context/admin-auth.errors';
import type { Resource } from '../resources/resource.service';
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
  return err;
}
