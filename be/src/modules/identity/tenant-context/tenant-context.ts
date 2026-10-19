import {
  applyDecorators,
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';
import { bearerToken } from '../../../common/http/bearer';
import type { HttpRequest } from '../../../common/http/http.types';
import type { AppConfig } from '../../../config/configuration';
import { type Client, ClientService } from '../../clients/client.service';
import { type AccessTokenClaims, TokenVerifier } from '../../keys/token-verifier';
import { isAccessTokenLive } from '../../oauth/access-token-liveness';
import { adminResourceIdentifier, isAdminCapableClient } from '../../oauth/token/token.service';
import { ResourceService } from '../../resources/resource.service';
import { SessionCookie } from '../../sessions/session.cookie';
import { SessionService } from '../../sessions/session.service';
import { UserTenantService } from '../user-tenant.service';
import { AdminAuthError } from './admin-auth.errors';

/** Brand key — NOT exported, so no code outside this file can mint a TenantContext. */
declare const brand: unique symbol;

/**
 * Authorized tenant scope of the current request (B2.1, spec §9.10, INV-24).
 * Only `TenantGuard` (session) and `AdminTokenGuard` (admin bearer token, B6.1) create it, and only
 * from a valid session/token + active membership;
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

/**
 * Admin principal set by `AdminTokenGuard` (private symbol): admin roles + raw `auth_time` + the
 * `client_id` that issued the admin token (B6.3a: lets a handler refuse to lock out its own BFF).
 */
const ADMIN_PRINCIPAL = Symbol('adminPrincipal');
type AdminPrincipal = Readonly<{ roles: readonly string[]; authTime: unknown; clientId: string }>;

type RequestWithTenant = {
  cookies?: Record<string, string | undefined>;
  [TENANT_CTX]?: TenantContext;
  [ADMIN_PRINCIPAL]?: AdminPrincipal;
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

/** Admin roles (plan D6, Q-26.1). Run 26 does not distinguish them: both see only the token's tenant. */
const ADMIN_ROLES: readonly string[] = ['super_admin', 'tenant_admin'];
const ADMIN_SCOPE_KEY = 'adminScope';

/** Required `admin.*` scope of an admin route: `admin.read` for GET, `admin.write` for mutations. */
export const AdminScope = (scope: 'admin.read' | 'admin.write') =>
  SetMetadata(ADMIN_SCOPE_KEY, scope);

/**
 * Admin API guard (B6.1, spec §9.10/§9.11, INV-24): bearer access token for the `admin` resource
 * ONLY (never the session cookie, D2). Order (fail-closed, opaque errors):
 *  1-5. `Authorization: Bearer` only -> `verifyAccessToken` (RS256/iss/typ=at+jwt/claims) -> `aud` =
 *       `adminResourceIdentifier(issuer)` -> `sid` REQUIRED (so a logout always revokes) -> shared
 *       liveness (`isAccessTokenLive`, same gate as `/userinfo`, `/demo/me`) => else 401 `invalid_token`;
 *  6. route scope in token scope => else 403 `insufficient_scope`;
 *  7. tenant = `tenantId` of the issuing client (server-side lookup, NEVER request input) + an ACTIVE
 *     `UserTenant` membership holding an admin role => else 403 `forbidden` (member vs role not told
 *     apart).
 * A Mongo/Redis fault at any step propagates (5xx), never a 401/403/200.
 * Mints the `TenantContext` (`@Tenant()`) and the admin principal (`@AdminRoles()`).
 */
@Injectable()
export class AdminTokenGuard implements CanActivate {
  private readonly adminAud: string;

  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
    private readonly clients: ClientService,
    private readonly sessions: SessionService,
    private readonly resources: ResourceService,
    private readonly memberships: UserTenantService,
    @InjectModel('User') private readonly users: Model<{ _id: Types.ObjectId }>,
    config: ConfigService,
  ) {
    this.adminAud = adminResourceIdentifier(config.getOrThrow<AppConfig>('app').issuer);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const scope = this.reflector.getAllAndOverride<string | undefined>(ADMIN_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!scope) {
      // Programming error: an admin route without a declared scope must never be reachable.
      throw new Error('AdminTokenGuard: route has no @AdminScope(...)');
    }
    const http = context.switchToHttp();
    const req = http.getRequest<HttpRequest & RequestWithTenant>();
    // Every admin response (incl. errors) carries tenant/role data or auth state: never cache.
    http
      .getResponse<{ header(name: string, value: string): unknown }>()
      .header('Cache-Control', 'no-store');

    const token = bearerToken(req);
    if (!token) throw AdminAuthError.invalidToken();
    let claims: AccessTokenClaims;
    try {
      claims = await this.verifier.verifyAccessToken(token);
    } catch {
      throw AdminAuthError.invalidToken();
    }
    if (claims.aud !== this.adminAud || claims.sid === undefined) {
      throw AdminAuthError.invalidToken();
    }
    // Capture the client the liveness gate already loads (one lookup, same snapshot for the tenant).
    const seen: { client?: Client | null } = {};
    const live = await isAccessTokenLive(
      claims,
      {
        findByClientId: async (id) => (seen.client = await this.clients.findByClientId(id)),
      },
      { exists: async (id) => (await this.users.exists({ _id: id })) !== null },
      this.sessions,
      this.resources,
    );
    if (!live || !seen.client) throw AdminAuthError.invalidToken();
    // DEBT-173(3): an `aud=admin` token minted before its client stopped being admin-capable (type /
    // auth method changed in DB) is refused at use too. Same opaque 401 as a non-live token.
    if (!isAdminCapableClient(seen.client)) throw AdminAuthError.invalidToken();

    if (!claims.scope.split(' ').includes(scope)) {
      throw AdminAuthError.insufficientScope(scope);
    }

    const tenantId = seen.client.tenantId;
    const roles = (await this.memberships.activeRoles(claims.sub, tenantId)) ?? [];
    const adminRoles = roles.filter((r) => ADMIN_ROLES.includes(r));
    if (adminRoles.length === 0) throw AdminAuthError.forbidden();

    req[TENANT_CTX] = Object.freeze({
      tenantId,
      userId: claims.sub,
      sessionRef: claims.sid,
    }) as TenantContext;
    req[ADMIN_PRINCIPAL] = Object.freeze({
      roles: Object.freeze(adminRoles),
      authTime: claims.auth_time,
      clientId: claims.client_id,
    });
    return true;
  }
}

/** `@AdminRoles() roles` - the admin roles resolved by `AdminTokenGuard`. */
export const AdminRoles = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const principal = context.switchToHttp().getRequest<RequestWithTenant>()[ADMIN_PRINCIPAL];
  if (!principal) {
    throw new Error('Admin principal missing: apply @UseGuards(AdminTokenGuard)');
  }
  return principal.roles;
});

/** What an admin handler may know about its caller (never `auth_time`/`sid`/the token). */
export type AdminActor = Readonly<{ roles: readonly string[]; clientId: string }>;

/** `@CurrentAdmin() actor` - roles + issuing `client_id` resolved by `AdminTokenGuard` (B6.3a). */
export const CurrentAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AdminActor => {
    const principal = context.switchToHttp().getRequest<RequestWithTenant>()[ADMIN_PRINCIPAL];
    if (!principal) {
      throw new Error('Admin principal missing: apply @UseGuards(AdminTokenGuard)');
    }
    return { roles: principal.roles, clientId: principal.clientId };
  },
);

/** DI token for the step-up clock (ms epoch); tests inject it to probe the N-minute boundary. */
export const STEP_UP_CLOCK = 'STEP_UP_CLOCK';
const RECENT_AUTH_KEY = 'requireRecentAuthMinutes';
/** Tolerated clock skew for an `auth_time` slightly in the future (seconds). */
const MAX_FUTURE_SKEW_SEC = 30;

/**
 * `auth_time` missing / not an integer / more than 30s in the future / older than N minutes =>
 * 403 `{error:"step_up_required", max_age:0}` (B6.2, INV-26, D3). A token from the refresh grant
 * never carries `auth_time`, so it always needs a fresh interactive login.
 */
@Injectable()
export class StepUpGuard implements CanActivate {
  private readonly now: () => number;

  constructor(
    private readonly reflector: Reflector,
    @Optional() @Inject(STEP_UP_CLOCK) now?: () => number,
  ) {
    this.now = now ?? Date.now;
  }

  canActivate(context: ExecutionContext): boolean {
    const minutes = this.reflector.getAllAndOverride<number | undefined>(RECENT_AUTH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const principal = context.switchToHttp().getRequest<RequestWithTenant>()[ADMIN_PRINCIPAL];
    if (typeof minutes !== 'number' || !principal) {
      // Programming error (no AdminTokenGuard before it): fail closed (5xx), never let it through.
      throw new Error('StepUpGuard: apply AdminTokenGuard and @RequireRecentAuth(minutes)');
    }
    const authTime = principal.authTime;
    const nowSec = Math.floor(this.now() / 1000);
    if (
      typeof authTime !== 'number' ||
      !Number.isInteger(authTime) ||
      authTime > nowSec + MAX_FUTURE_SKEW_SEC ||
      nowSec - authTime > minutes * 60
    ) {
      throw AdminAuthError.stepUpRequired();
    }
    return true;
  }
}

/**
 * Step-up decorator (B6.2): the admin access token's `auth_time` must be at most `minutes` old (D3:
 * use 5). Adds a METHOD-level `StepUpGuard`, so with `AdminTokenGuard` at controller level the
 * B6.1 401/403 always take precedence.
 */
export const RequireRecentAuth = (minutes: number) =>
  applyDecorators(SetMetadata(RECENT_AUTH_KEY, minutes), UseGuards(StepUpGuard));
