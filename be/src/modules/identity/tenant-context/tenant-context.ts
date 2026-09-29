import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { SessionCookie } from '../../sessions/session.cookie';
import { SessionService } from '../../sessions/session.service';
import { UserTenantService } from '../user-tenant.service';

/** Brand key — NOT exported, so no code outside this file can mint a TenantContext. */
declare const brand: unique symbol;

/**
 * Authorized tenant scope of the current request (B2.1, spec §9.10, INV-24).
 * Only `TenantGuard` creates it, and only from a valid session + active membership;
 * never from body/query/header.
 */
export type TenantContext = Readonly<{
  tenantId: string;
  userId: string;
  sessionRef: string;
  [brand]: true;
}>;

/** Where the guard stores the context on the request (private symbol, not a readable field name). */
const TENANT_CTX = Symbol('tenantContext');

type RequestWithTenant = {
  cookies?: Record<string, string | undefined>;
  [TENANT_CTX]?: TenantContext;
};

/**
 * Resolves the tenant **only** from the authenticated session (A5; the access-token source comes
 * in B6.1). Requires an active `UserTenant` membership, so removing a membership revokes access
 * immediately. No session → 401, no membership → 403.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly cookie: SessionCookie,
    private readonly memberships: UserTenantService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithTenant>();
    const id = this.cookie.read(req);
    const session = id ? await this.sessions.get(id) : null;
    if (!session) {
      throw new UnauthorizedException('Authentication required');
    }
    if (!(await this.memberships.isActiveMember(session.userId, session.tenantId))) {
      throw new ForbiddenException('No access to this tenant');
    }
    req[TENANT_CTX] = Object.freeze({
      tenantId: session.tenantId,
      userId: session.userId,
      sessionRef: session.ref,
    }) as TenantContext;
    return true;
  }
}

/** `@Tenant() ctx: TenantContext` — injects the context set by `TenantGuard`. */
export const Tenant = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const ctx = context.switchToHttp().getRequest<RequestWithTenant>()[TENANT_CTX];
  if (!ctx) {
    // Programming error: route uses @Tenant() without TenantGuard.
    throw new Error('TenantContext missing: apply @UseGuards(TenantGuard)');
  }
  return ctx;
});
