import type { AuditAction } from './audit-action.enum';

/** Metadata keys that must never be written to an audit event (INV-20, INV-25). */
type ForbiddenMetadataKey =
  | 'password'
  | 'passwordHash'
  | 'token'
  | 'accessToken'
  | 'access_token'
  | 'refreshToken'
  | 'refresh_token'
  | 'idToken'
  | 'id_token'
  | 'code'
  | 'authorizationCode'
  | 'authorization_code'
  | 'codeVerifier'
  | 'code_verifier'
  | 'secret'
  | 'secretHash'
  | 'tokenHash'
  | 'clientSecret'
  | 'client_secret'
  | 'privateKey'
  | 'cookie'
  | 'authorization';

/**
 * Flat, primitive-only metadata. Forbidden keys are typed `never`, so an
 * object literal containing them does not compile; nested objects are not
 * allowed so secrets cannot hide one level down.
 */
export type AuditMetadata = { [key: string]: string | number | boolean | null } & {
  [K in ForbiddenMetadataKey]?: never;
};

export type AuditActorType = 'user' | 'client' | 'admin' | 'system';

export interface AuditEventInput {
  actorType: AuditActorType;
  actorId?: string;
  tenantId?: string;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  clientId?: string;
  ip?: string;
  userAgent?: string;
  requestId?: string;
  result: 'success' | 'failure';
  reason?: string;
  metadata?: AuditMetadata;
}

export interface AuditEvent extends AuditEventInput {
  eventId: string;
  timestamp: Date;
}

export type AuditAlertListener = (event: AuditEvent) => void | Promise<void>;
