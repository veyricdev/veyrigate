import { Controller, HttpStatus, Logger, Post, Req, Res } from '@nestjs/common';
import { FormParseError, assertFormContentType, parseForm } from '../../../common/http/form';
import type { HttpRequest } from '../../../common/http/http.types';
import { deriveS256Challenge } from '../../../common/crypto/pkce.util';
import { observeTokenError, type TokenEndpoint } from '../../../common/metrics/metrics';
import {
  ClientAuthRateLimitedError,
  ClientAuthenticationService,
  InvalidClientError,
} from '../../clients/client-authentication.service';
import {
  ClientAuthRequestError,
  basicAuthHeader,
  resolveClientAuth,
} from '../../clients/client-auth-request';
import { applyCors, requestOrigin } from '../../clients/client-cors.helper';
import { ClientCorsService } from '../../clients/client-cors.service';
import { ClientService, type Client } from '../../clients/client.service';
import { isRegisteredRedirectUri } from '../../clients/redirect-uri.validator';
import { UserTenantService } from '../../identity/user-tenant.service';
import { ADMIN_LOCKED_UNTIL, UserService } from '../../identity/user.service';
import { SessionService } from '../../sessions/session.service';
import {
  AuthorizationCodeService,
  type AuthorizationCodeData,
} from '../code/authorization-code.service';
import { ResourceService } from '../../resources/resource.service';
import { ConsentService } from '../consent/consent.service';
import { TokenError } from './token.errors';
import { TokenService, adminTargetForbidden } from './token.service';
import { RefreshRotationError, RefreshTokenService } from './refresh-token.service';
import { errorForLog } from '../../../common/logger/error-log';
import {
  DEPENDENCY_RETRY_AFTER_SEC,
  isDependencyUnavailable,
} from '../../../common/errors/dependency-unavailable';

/** Reply members the `/token` controller needs (Fastify). Declared structurally like HttpReply. */
interface TokenReply {
  status(code: number): TokenReply;
  header(name: string, value: string): TokenReply;
  send(payload: unknown): unknown;
}

/** PKCE code_verifier charset/length (RFC 7636 ?4.1). */
const CODE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

/**
 * `POST /token` grant `authorization_code` (B4.4, spec ?8/?9.3/?9.5).
 *
 * Order (so a bad request never destroys a valid code ? INV-13): parse form => resolve client
 * auth => authenticate client => check the client may use this grant => consume+bind the code
 * (atomic, binds client_id/redirect_uri/PKCE challenge) => issue tokens. Every response (success
 * or error) is `no-store`; 401 `invalid_client` via Basic carries `WWW-Authenticate`. OAuth
 * errors are rendered here, not via the global filter (which maps by status only).
 */
@Controller()
export class TokenController {
  private readonly logger = new Logger(TokenController.name);

  constructor(
    private readonly clientAuth: ClientAuthenticationService,
    private readonly codes: AuthorizationCodeService,
    private readonly tokens: TokenService,
    private readonly refresh: RefreshTokenService,
    private readonly cors: ClientCorsService,
    private readonly sessions: SessionService,
    private readonly clients: ClientService,
    private readonly users: UserService,
    private readonly memberships: UserTenantService,
    private readonly consents: ConsentService,
    private readonly resources: ResourceService,
  ) {}

  @Post('/token')
  async token(@Req() req: HttpRequest, @Res() reply: TokenReply): Promise<unknown> {
    noStore(reply);
    try {
      return await this.handle(req, reply);
    } catch (err) {
      return this.renderError('token', req, reply, err);
    }
  }

  /**
   * `POST /revoke` (RFC 7009). Reuses the `/token` form parsing + client auth. A refresh token is
   * revoked together with its whole family (RFC 7009 §2.1 permits revoking related tokens; with
   * rotation, revoking a single value is meaningless — the descendant the client holds is what
   * must die). Bound to the authenticated client (IDOR guard). Per RFC 7009 the response is 200
   * even for an unknown/already-revoked/other-client token (no enumeration); only client-auth
   * failure (401) and infrastructure failure (500, fail-closed) deviate.
   */
  @Post('/revoke')
  async revoke(@Req() req: HttpRequest, @Res() reply: TokenReply): Promise<unknown> {
    noStore(reply);
    try {
      return await this.handleRevoke(req, reply);
    } catch (err) {
      return this.renderError('revoke', req, reply, err);
    }
  }

  private async handle(req: HttpRequest, reply: TokenReply): Promise<unknown> {
    const body = this.parseFormBody(req);

    // Only grants we actually support reach client auth; anything else is unsupported_grant_type
    // BEFORE touching credentials (B4.4 behaviour preserved for authorization_code).
    const grantType = body.get('grant_type');
    if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
      throw new TokenError('unsupported_grant_type');
    }

    // Client authentication is shared by every grant, performed before any state change.
    const client = await this.authenticateClient(req, body);
    await this.applyCors(req, reply, client.clientId);

    if (grantType === 'refresh_token') {
      return this.handleRefreshGrant(req, reply, body, client);
    }
    return this.handleAuthorizationCodeGrant(req, reply, body, client);
  }

  /**
   * Dynamic CORS for `/token` and `/revoke` (DEBT-019, spec §9.7): a browser SPA (public client)
   * calls `/token` directly, so the response echoes the Origin only when it is registered for the
   * authenticated client. Applied AFTER client auth so the decision is bound to a real client.
   */
  private async applyCors(req: HttpRequest, reply: TokenReply, clientId: string): Promise<void> {
    const origin = requestOrigin(req);
    if (origin) {
      applyCors(reply, origin, await this.cors.isOriginAllowedForClient(clientId, origin));
    }
  }

  /** Authenticate the client (RFC 6749 §2.3); InvalidClient => 401 invalid_client. */
  private async authenticateClient(req: HttpRequest, body: Map<string, string>) {
    let auth;
    try {
      auth = resolveClientAuth(req, body);
    } catch (e) {
      if (e instanceof ClientAuthRequestError) {
        throw new TokenError(e.code, e.status);
      }
      throw e;
    }
    try {
      return await this.clientAuth.authenticate(auth, { ip: req.ip });
    } catch (e) {
      if (e instanceof InvalidClientError) {
        throw new TokenError('invalid_client', HttpStatus.UNAUTHORIZED);
      }
      throw e; // ClientAuthRateLimitedError / infra errors handled by renderError.
    }
  }

  /** `grant_type=authorization_code` (B4.4): consume+bind the code atomically, then issue tokens. */
  private async handleAuthorizationCodeGrant(
    req: HttpRequest,
    reply: TokenReply,
    body: Map<string, string>,
    client: Awaited<ReturnType<ClientAuthenticationService['authenticate']>>,
  ): Promise<unknown> {
    // The client must be allowed to use this grant.
    if (!client.grantTypes.includes('authorization_code')) {
      throw new TokenError('unauthorized_client');
    }

    // PKCE verifier format (cheap, before Redis).
    const code = body.get('code');
    const redirectUri = body.get('redirect_uri');
    const verifier = body.get('code_verifier');
    if (!code || !redirectUri || !verifier || !CODE_VERIFIER_RE.test(verifier)) {
      throw new TokenError('invalid_grant');
    }

    // 4) Atomic consume-with-binding: client_id + redirect_uri + PKCE challenge must all match,
    // otherwise the code is left intact (INV-13). A mismatch/missing/expired code => invalid_grant.
    const challenge = deriveS256Challenge(verifier);
    const data = await this.codes.consume(code, client.clientId, redirectUri, challenge);
    if (!data) {
      throw new TokenError('invalid_grant');
    }

    // 5) A `resource` in the body (RFC 8707) may only confirm the bound resource, never change aud.
    const bodyResource = body.get('resource');
    if (bodyResource !== undefined && bodyResource !== data.resource) {
      throw new TokenError('invalid_target');
    }

    // 6) Session liveness (DEBT-043): the code was bound to the browser session that authorized it.
    // The code is single-use and already consumed above, but it stays exchangeable for ≤60s — long
    // enough for a logout (or idle expiry) to happen in between. Refuse to mint a refresh family for
    // a session that is no longer live, so a logged-out session's code cannot be turned into a new
    // long-lived grant. `sessionRef` is required on every minted code; a code without it (only
    // possible for a code minted just before this deploy) fails closed. A Redis error propagates to
    // a fail-closed 500 (no token minted). The code is gone either way (single-use preserved).
    if (!data.sessionRef) {
      throw new TokenError('invalid_grant');
    }
    if (!(await this.sessions.exists(data.sessionRef))) {
      throw new TokenError('invalid_grant');
    }

    const audit = { ip: req.ip, requestId: req.id };
    const { response, familyId } = await this.tokens.issueForAuthorizationCode(client, data, audit);

    // DEBT-051 / INV-29: the `exists` check above is a fail-fast read; a logout can still slip in
    // between it and the family insert (TOCTOU). Re-check AFTER the insert for EVERY code grant —
    // even one that minted no refresh family (no `offline_access`) must not hand a logged-out
    // session a fresh access/id token. If the session is gone now, refuse to return any token; and
    // if a family WAS minted, revoke it first. Only `revokeFamilyForEndedSession` (scoped to the
    // just-minted `familyId` + this client) — NOT `revokeForSession`, which would also kill an
    // older `offline_access` family of a session that merely idle-expired in the window (§8
    // limit 1). A Redis error on the re-check still fails closed (500): the family is revoked
    // best-effort first so no orphan grant survives, then the original error propagates. Combined
    // with the SWEEP in logout/reset (§9.8) no family survives bound to an actively-ended session.
    let live: boolean;
    try {
      live = await this.sessions.exists(data.sessionRef);
    } catch (err) {
      // Redis error on the re-check: revoke any minted family (best-effort) and record a
      // `TOKEN_ISSUED failure reason:'session_check_failed'` (best-effort — never masks the
      // original error), then fail closed (500). No token is returned, no audit claims success.
      return this.failClosed(client, data, familyId, 'session_check_failed', audit, err);
    }
    if (!live) {
      // Session ended during the exchange window: record exactly one
      // `TOKEN_ISSUED failure reason:'session_ended'` for EVERY code grant (with or without a
      // family). A family that WAS minted is additionally revoked via
      // `revokeFamilyForEndedSession`, which records its own `TOKEN_REVOKED session_ended` (a real
      // revoke). No `TOKEN_REVOKED` for the no-family branch (nothing is revoked).
      // DEBT-067: record the refusal audit even if the family revoke throws (Mongo down). The audit
      // write is best-effort (never masks the revoke error); without this try/catch a throwing
      // revoke skips `recordIssued` entirely, losing the `TOKEN_ISSUED failure session_ended` for a
      // rejected grant. `finally` is unusable here (it would double-write on the success path).
      return this.refuseGrant(client, data, familyId, 'session_ended', audit, (id) =>
        this.refresh.revokeFamilyForEndedSession(id, client.clientId, new Date(), {
          ip: req.ip,
          requestId: req.id,
        }),
      );
    }
    // DEBT-116/128/141/144/156: re-read the CURRENT grant preconditions AFTER the family insert.
    // Every revoking side (disable client, lock user, revoke consent) writes its state first and
    // sweeps families second, so "insert, then re-read" leaves no interleaving where a family
    // survives. A failure revokes the just-minted family and answers the same opaque invalid_grant
    // (reason only in audit); an infra error revokes best-effort and fails closed (500).
    let failure: string | null;
    try {
      failure = await this.recheckCodeGrant(client.clientId, data);
    } catch (err) {
      return this.failClosed(client, data, familyId, 'recheck_failed', audit, err);
    }
    if (failure !== null) {
      return this.refuseGrant(client, data, familyId, failure, audit);
    }
    // The session is live now: record `TOKEN_ISSUED success` right before the token leaves the
    // server (INV-25). If the audit write fails, revoke any minted family best-effort and fail
    // closed (500) — never return a token for which no `success` was recorded (no orphan grant).
    try {
      await this.tokens.recordIssued(client, data, 'success', !!familyId, undefined, audit);
    } catch (err) {
      if (familyId) {
        await this.refresh
          .revokeFamily(familyId, client.clientId, new Date())
          .catch(() => undefined);
      }
      throw err;
    }
    return reply.status(HttpStatus.OK).send(response);
  }

  /**
   * DEBT-213: refuse a code grant after the family insert. Revoke the family (if minted) via
   * `revoke`; if that throws, record the refusal best-effort and rethrow (DEBT-067). Otherwise
   * record exactly one `TOKEN_ISSUED failure <reason>` (not swallowed) and answer `invalid_grant`.
   */
  private async refuseGrant(
    client: Client,
    data: AuthorizationCodeData,
    familyId: string | undefined,
    reason: string,
    audit: { ip?: string; requestId?: string },
    revoke: (id: string) => Promise<unknown> = (id) =>
      this.refresh.revokeFamily(id, client.clientId, new Date()),
  ): Promise<never> {
    if (familyId) {
      try {
        await revoke(familyId);
      } catch (err) {
        await this.tokens
          .recordIssued(client, data, 'failure', true, reason, audit)
          .catch(() => undefined);
        throw err;
      }
    }
    await this.tokens.recordIssued(client, data, 'failure', !!familyId, reason, audit);
    throw new TokenError('invalid_grant');
  }

  /** Infra error while deciding: revoke (best-effort), audit `reason` (best-effort), rethrow (500). */
  private async failClosed(
    client: Client,
    data: AuthorizationCodeData,
    familyId: string | undefined,
    reason: string,
    audit: { ip?: string; requestId?: string },
    err: unknown,
  ): Promise<never> {
    if (familyId) {
      await this.refresh.revokeFamily(familyId, client.clientId, new Date()).catch(() => undefined);
    }
    await this.tokens
      .recordIssued(client, data, 'failure', !!familyId, reason, audit)
      .catch(() => undefined);
    throw err;
  }

  /**
   * Subject state a grant (code or refresh) still requires (run 36 G1). `user_locked` only for a
   * vanished user or an ADMIN lock: a brute-force lock is attacker-triggerable and by design does
   * not sweep sessions/families, so refusing on it would let anyone knowing the email kill the
   * victim's grants. `not_member` when the membership in the client's tenant is no longer active.
   */
  private async subjectFailure(
    userId: string,
    tenantId: string,
  ): Promise<'user_locked' | 'not_member' | null> {
    const user = await this.users.findById(userId);
    if (!user || user.lockedUntil?.getTime() === ADMIN_LOCKED_UNTIL.getTime()) {
      return 'user_locked';
    }
    if (!(await this.memberships.isActiveMember(userId, tenantId))) {
      return 'not_member';
    }
    return null;
  }

  /**
   * Current-state re-check of a code grant (run 35), in a fixed order; returns the first failing
   * reason or null. The tenant comes from the client document just re-read (INV-24). The resource
   * uses the same predicate as `decideConsent` (resolved by resourceId, DEBT-210). Consent uses
   * the full `isCovered` (scopes + policy/terms versions, Q35.5). DB faults propagate.
   */
  private async recheckCodeGrant(
    clientId: string,
    data: AuthorizationCodeData,
  ): Promise<string | null> {
    const fresh = await this.clients.findByClientId(clientId);
    if (!fresh) return 'client_disabled';
    if (!isRegisteredRedirectUri(fresh.redirectUris, data.redirectUri)) {
      return 'redirect_uri_unregistered';
    }
    if (
      data.resource &&
      (adminTargetForbidden(fresh, data.resource, this.tokens.adminResource) ||
        (await this.resources.resolveForClient(fresh.allowedResources, data.resource)) === null)
    ) {
      return 'resource_not_allowed';
    }
    const subject = await this.subjectFailure(data.userId, fresh.tenantId);
    if (subject) return subject;
    const consent = await this.consents.find(data.userId, clientId, data.resource);
    const scopes = data.scope.split(' ').filter(Boolean);
    if (!this.consents.isCovered(consent, scopes, this.consents.currentVersions())) {
      return 'consent_revoked';
    }
    return null;
  }

  /**
   * `grant_type=refresh_token` (B4.5, RFC 6749 §6 / spec §9.5). Client auth already ran; here we
   * check the client holds the grant, read the required `refresh_token`, and delegate to
   * `RefreshTokenService.issueForRefresh` (scope-narrow check → atomic rotation → sign → audit).
   * Rotation/reuse failures collapse to `invalid_grant` (no enumeration, no detail leak).
   */
  private async handleRefreshGrant(
    req: HttpRequest,
    reply: TokenReply,
    body: Map<string, string>,
    client: Awaited<ReturnType<ClientAuthenticationService['authenticate']>>,
  ): Promise<unknown> {
    // The client must be allowed to use this grant (RFC 6749 §5.2 => unauthorized_client).
    if (!client.grantTypes.includes('refresh_token')) {
      throw new TokenError('unauthorized_client');
    }

    const refreshToken = body.get('refresh_token');
    if (!refreshToken) {
      throw new TokenError('invalid_request');
    }

    const audit = { ip: req.ip, userAgent: userAgentHeader(req), requestId: req.id };
    try {
      const response = await this.refresh.issueForRefresh(
        refreshToken,
        {
          clientId: client.clientId,
          allowedResources: client.allowedResources,
          clientType: client.clientType,
          tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
          tenantId: client.tenantId,
        },
        { scope: body.get('scope'), resource: body.get('resource') },
        // DEBT-207: after rotate, the client (re-read), user and membership must still be valid.
        async (userId) => {
          const fresh = await this.clients.findByClientId(client.clientId);
          if (!fresh) return 'client_disabled';
          return this.subjectFailure(userId, fresh.tenantId);
        },
        audit,
      );
      return reply.status(HttpStatus.OK).send(response);
    } catch (e) {
      // Both "unknown/expired/revoked" and "reuse (family already revoked here)" map to the same
      // opaque invalid_grant so a client cannot distinguish them (spec §9.5 anti-enumeration).
      if (e instanceof RefreshRotationError) {
        throw new TokenError('invalid_grant');
      }
      throw e;
    }
  }

  /** `POST /revoke` body handler: parse + auth (shared with `/token`), then revoke the family. */
  private async handleRevoke(req: HttpRequest, reply: TokenReply): Promise<unknown> {
    const body = this.parseFormBody(req);

    // Client auth is mandatory before any write (same path as /token).
    const client = await this.authenticateClient(req, body);
    await this.applyCors(req, reply, client.clientId);

    // `token_type_hint` is accepted and ignored (RFC 7009 §2.1). A JWT access token cannot be
    // revoked before `exp` (spec §8), so a non-refresh value simply no-ops inside the service.
    const token = body.get('token');
    if (!token) {
      throw new TokenError('invalid_request');
    }

    const audit = { ip: req.ip, userAgent: userAgentHeader(req), requestId: req.id };
    await this.refresh.revokeByToken(token, client.clientId, audit);
    // RFC 7009 §2.2: an empty 200 body signals success (idempotent, non-leaking).
    return reply.status(HttpStatus.OK).send({});
  }

  /** Shared form parsing (`common/http/form`); a bad content-type / repeated param => invalid_request. */
  private parseFormBody(req: HttpRequest): Map<string, string> {
    try {
      assertFormContentType(req);
      return parseForm(req);
    } catch (e) {
      if (e instanceof FormParseError) {
        throw new TokenError('invalid_request');
      }
      throw e;
    }
  }

  private renderError(
    endpoint: TokenEndpoint,
    req: HttpRequest,
    reply: TokenReply,
    err: unknown,
  ): unknown {
    const unavailable = isDependencyUnavailable(err);
    // B7.2: one count per error response (429/503 included); never throws into the response path.
    try {
      observeTokenError(
        endpoint,
        err instanceof ClientAuthRateLimitedError || unavailable
          ? 'temporarily_unavailable'
          : err instanceof TokenError
            ? err.code
            : 'server_error',
      );
    } catch (metricsErr) {
      this.logger.error(`token metrics failed: ${(metricsErr as Error).message}`);
    }
    // Client-auth failure rate limit (DEBT-029/039): 429 + Retry-After, no WWW-Authenticate, no
    // echo of input. The counter is NOT incremented by this 429 (window expires on its own).
    if (err instanceof ClientAuthRateLimitedError) {
      return reply
        .status(HttpStatus.TOO_MANY_REQUESTS)
        .header('Retry-After', String(err.retryAfterSec))
        .send({
          error: 'temporarily_unavailable',
          error_description: descriptionFor('temporarily_unavailable'),
        });
    }
    // Dependency outage (Redis / key provider, run 53c): 503 + Retry-After, no token (fail-closed).
    if (unavailable) {
      this.logger.error(errorForLog(err));
      return reply
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .header('Retry-After', String(DEPENDENCY_RETRY_AFTER_SEC))
        .send({
          error: 'temporarily_unavailable',
          error_description: descriptionFor('temporarily_unavailable'),
        });
    }
    const tokenError =
      err instanceof TokenError
        ? err
        : new TokenError('server_error', HttpStatus.INTERNAL_SERVER_ERROR);
    if (!(err instanceof TokenError)) {
      // Infrastructure failure (sign/DB/Redis/audit): fail-closed, no token, no leak of details.
      this.logger.error(errorForLog(err));
    }
    // RFC 6749 §5.2: a 401 to a client authenticating via Basic must include WWW-Authenticate.
    if (tokenError.code === 'invalid_client' && basicAuthHeader(req) !== undefined) {
      reply.header('WWW-Authenticate', 'Basic realm="token"');
    }
    return reply.status(tokenError.status).send({
      error: tokenError.code,
      error_description: descriptionFor(tokenError.code),
    });
  }
}

/** The first `User-Agent` header value (best-effort, stored on the refresh doc only). */
function userAgentHeader(req: HttpRequest): string | undefined {
  const raw = req.headers['user-agent'];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** Static, non-leaking descriptions (never echo client input). */
function descriptionFor(code: string): string {
  switch (code) {
    case 'invalid_request':
      return 'The request is missing a parameter or is otherwise malformed.';
    case 'invalid_client':
      return 'Client authentication failed.';
    case 'invalid_grant':
      return 'The provided grant is invalid, expired, or revoked.';
    case 'unauthorized_client':
      return 'The client is not authorized to use this grant type.';
    case 'unsupported_grant_type':
      return 'The grant type is not supported.';
    case 'invalid_scope':
      return 'The requested scope exceeds the scope granted to the original token.';
    case 'invalid_target':
      return 'The requested resource is invalid.';
    case 'temporarily_unavailable':
      return 'Too many failed client authentications. Try again later.';
    default:
      return 'The authorization server encountered an unexpected condition.';
  }
}

/** Mark a response as uncacheable (RFC 6749 ?5.1 / ?5.2). */
function noStore(reply: TokenReply): void {
  reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');
}
