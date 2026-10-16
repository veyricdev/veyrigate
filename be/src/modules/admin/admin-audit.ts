import type { HttpRequest } from '../../common/http/http.types';
import type { TenantContext } from '../identity/tenant-context/tenant-context';
import type { AuditEventInput } from '../security/audit/audit.types';

/**
 * Common audit fields of an admin write (B6.3a): actor = token `sub`, tenant = token tenant, plus
 * request correlation. Metadata stays the caller's job and must be flat, non-secret, and use key
 * names `sanitizeMetadata` keeps (no `token|secret|password|...` substring), e.g. `changedFields`.
 */
export function adminAuditBase(
  req: HttpRequest,
  ctx: TenantContext,
): Pick<AuditEventInput, 'actorType' | 'actorId' | 'tenantId' | 'requestId' | 'ip' | 'userAgent'> {
  const ua = req.headers['user-agent'];
  return {
    actorType: 'admin',
    actorId: ctx.userId,
    tenantId: ctx.tenantId,
    requestId: req.id,
    ip: req.ip,
    userAgent: typeof ua === 'string' ? ua : undefined,
  };
}
