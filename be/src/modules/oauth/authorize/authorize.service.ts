import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../../config/configuration';
import { AuditAction } from '../../security/audit/audit-action.enum';
import { AuditService } from '../../security/audit/audit.service';
import { ClientService, type Client } from '../../clients/client.service';
import { isRegisteredRedirectUri } from '../../clients/redirect-uri.validator';
import { ResourceService } from '../../resources/resource.service';
import { InvalidResourceError } from '../../resources/resource.validator';
import { AuthorizeErrorPage, AuthorizeRedirectError } from './authorize.errors';
import {
  AuthorizeRequestContextService,
  type AuthorizeRequestContext,
} from './authorize-request-context.service';
import { AuthorizationCodeService } from '../code/authorization-code.service';
import { ConsentService } from '../consent/consent.service';
import { SessionService } from '../../sessions/session.service';
import { UserTenantService } from '../../identity/user-tenant.service';
import { adminResourceIdentifier, adminTargetForbidden } from '../token/token.service';

/** Raw `/authorize` query parameters (already string-typed by the HTTP layer). */
export interface AuthorizeParams {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  scope?: string;
  resource?: string;
  state?: string;
  nonce?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  prompt?: string;
  max_age?: string;
  /** Opaque IdP request id used to resume a stored context after login (spec §9.1). */
  request_id?: string;
}

/** The minimal view of the current session the flow needs (null when not signed in). */
export interface SessionView {
  userId: string;
  /** ms epoch of the authentication that established the session. */
  authTime: number;
  /** sha256 of the session cookie id (`Session.ref`); bound onto any RefreshToken this session
   * mints so a local logout can target exactly this browser session (B4.7). */
  ref: string;
  /** Authentication methods of the session (DEBT-030); carried into the code, then the ID token. */
  amr?: string[];
}

/**
 * Outcome of `/authorize` (B4.1 + B4.2). The controller turns each outcome into an HTTP response.
 * `code_issued` is the walking-skeleton terminal: B4.2 mints an authorization code and the
 * controller 302-redirects it to the RP (`code`/`state`/`iss`); `/token` to exchange it is B4.4.
 */
export type AuthorizeOutcome =
  /** Not signed in (and interaction allowed): send the user to the login page, resumable via requestId. */
  | { kind: 'login_required'; requestId: string }
  /**
   * Signed in, valid, but consent is needed (missing coverage or `prompt=consent`). Render the
   * consent screen; `requestId` resumes the stored context on the POST. `scopes`/`resource`/
   * `clientId` are what the screen displays -- the redirect params are NEVER taken from the POST.
   */
  | {
      kind: 'consent_required';
      requestId: string;
      clientId: string;
      scopes: string[];
      resource: string;
      /**
       * Already-validated (exact-matched) redirect URI (DEBT-084). Used ONLY to derive the consent
       * page's per-response CSP `form-action` origin — it is NEVER passed to the template and the
       * redirect is always rebuilt from the stored context on the POST.
       */
      redirectUri: string;
    }
  /** Consent already satisfied (or just granted): a code was issued, redirect it to the RP. */
  | { kind: 'code_issued'; redirectUri: string; code: string; state?: string };

/**
 * The `/authorize` parameters this IdP recognises (DEBT-204/205). RFC 6749 §3.1: a recognised
 * parameter MUST NOT appear more than once; an unrecognised one is ignored (even if repeated).
 */
export const AUTHORIZE_PARAM_KEYS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'scope',
  'resource',
  'state',
  'nonce',
  'code_challenge',
  'code_challenge_method',
  'prompt',
  'max_age',
  'request_id',
] as const;

/**
 * First of `keys` whose value is neither absent nor a single string (Fastify parses a repeated
 * query parameter into an array), or undefined when all are well-formed. Pure.
 */
export function repeatedParam(
  params: object,
  keys: readonly string[] = AUTHORIZE_PARAM_KEYS,
): string | undefined {
  const values = params as Record<string, unknown>;
  return keys.find((k) => values[k] !== undefined && typeof values[k] !== 'string');
}

/** Phase 2 keys: every recognised one except those owned by Phase 1 / `resolveResource`. */
const PHASE2_PARAM_KEYS = AUTHORIZE_PARAM_KEYS.filter(
  (k) => k !== 'client_id' && k !== 'redirect_uri' && k !== 'resource',
);

/** PKCE S256 challenge: 43–128 chars of base64url (RFC 7636). */
const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;

/**
 * `/authorize` request validation and flow decision (B4.1, spec §9.1–9.2).
 *
 * Order matters for open-redirect safety (INV-3, tech-lead C2): `client_id` and `redirect_uri`
 * are resolved and validated FIRST. Any failure there throws `AuthorizeErrorPage` (rendered as a
 * first-party page, never redirected). Only after `redirect_uri` is trusted do remaining
 * validation failures throw `AuthorizeRedirectError` (returned to the RP via redirect).
 */
@Injectable()
export class AuthorizeService {
  private readonly issuer: string;
  /** The admin API's resource identifier, derived once from the issuer (DEBT-175). */
  private readonly adminAud: string;

  constructor(
    private readonly clients: ClientService,
    private readonly resources: ResourceService,
    private readonly contexts: AuthorizeRequestContextService,
    private readonly audit: AuditService,
    private readonly consents: ConsentService,
    private readonly codes: AuthorizationCodeService,
    private readonly sessions: SessionService,
    config: ConfigService,
    private readonly memberships: UserTenantService,
  ) {
    this.issuer = config.getOrThrow<AppConfig>('app').issuer;
    this.adminAud = adminResourceIdentifier(this.issuer);
  }

  get issuerUrl(): string {
    return this.issuer;
  }

  /**
   * Validate the request and decide the next step. `session` is the caller's current session
   * (null when signed out). Does NOT issue a code/token (out of scope for B4.1).
   */
  /**
   * Resume an `/authorize` request after the user has interacted (login, spec §9.1): consume the
   * stored `AuthorizeRequestContext` by its opaque `request_id`, rebuild the original parameters
   * from it, and run the same decision as a fresh request. Returns null when the context is
   * missing/expired/already consumed, so the controller can show a first-party error page (never
   * a redirect — the original parameters, including `redirect_uri`, are gone).
   */
  async resume(
    requestId: string,
    session: SessionView | null,
    audit: { ip?: string; userAgent?: string; requestId?: string } = {},
  ): Promise<AuthorizeOutcome | null> {
    const ctx = await this.contexts.consume(requestId);
    // Only a login context resumes here; a consent context belongs to POST /authorize/consent.
    if (!ctx || ctx.kind !== 'login') return null;
    // B6.2 / OIDC Core §3.1.2.1: a context created because re-authentication was demanded must
    // only resume with a session that authenticated AFTER that demand. Otherwise (no session, or the
    // old session re-used by calling `/authorize?request_id=` directly) => `login_required` to the RP.
    // The context is already consumed (single-use), so this cannot loop or later mint a code.
    if (ctx.reauthAfter !== undefined && (session === null || session.authTime < ctx.reauthAfter)) {
      const err = new AuthorizeRedirectError('login_required', 'Re-authentication is required.');
      err.redirectUri = ctx.redirectUri;
      err.state = ctx.originalState;
      throw err;
    }
    const params: AuthorizeParams = {
      response_type: 'code',
      client_id: ctx.clientId,
      redirect_uri: ctx.redirectUri,
      scope: ctx.scope,
      resource: ctx.resource,
      state: ctx.originalState,
      nonce: ctx.nonce,
      code_challenge: ctx.codeChallenge,
      code_challenge_method: 'S256',
    };
    return this.handle(params, session, audit);
  }

  async handle(
    params: AuthorizeParams,
    session: SessionView | null,
    audit: { ip?: string; userAgent?: string; requestId?: string } = {},
  ): Promise<AuthorizeOutcome> {
    // --- Phase 1: establish a trusted redirect_uri (INV-3). Failures here => error page. ---
    // DEBT-205: a repeated client_id/redirect_uri arrives as an array. Refuse it BEFORE the lookup
    // (Mongoose would cast an array to `$in`); no redirect_uri is trusted yet => error page.
    if (repeatedParam(params, ['client_id', 'redirect_uri']) !== undefined) {
      throw new AuthorizeErrorPage('repeated_parameter');
    }
    const clientId = params.client_id;
    if (!clientId) {
      throw new AuthorizeErrorPage('missing_client_id');
    }
    const client = await this.clients.findByClientId(clientId);
    if (!client) {
      throw new AuthorizeErrorPage('unknown_client');
    }
    const redirectUri = params.redirect_uri;
    if (!redirectUri || !isRegisteredRedirectUri(client.redirectUris, redirectUri)) {
      throw new AuthorizeErrorPage('invalid_redirect_uri');
    }

    // --- Phase 2: redirect_uri trusted. Remaining failures => redirect with OAuth error. ---
    // Wrapped so every `AuthorizeRedirectError` gets `redirectUri`/`state` attached before it
    // leaves `handle()` (see catch below) -- the controller then builds the redirect purely from
    // the error, which is required on the resume-after-login path where the inbound HTTP params
    // no longer carry `redirect_uri`/`state` (those live in the already-consumed context).
    try {
      // DEBT-204/205: any other recognised parameter repeated => invalid_request to the trusted
      // redirect_uri (no 500, no array reaching a context/code). `resource` keeps invalid_target.
      if (repeatedParam(params, PHASE2_PARAM_KEYS) !== undefined) {
        throw new AuthorizeRedirectError('invalid_request', 'Repeated parameter.');
      }
      if (params.response_type !== 'code') {
        throw new AuthorizeRedirectError(
          'unsupported_response_type',
          'Only response_type=code is supported.',
        );
      }
      if (params.code_challenge_method !== 'S256') {
        // Reject missing or `plain` — PKCE S256 is mandatory (spec §9.2, INV-15).
        throw new AuthorizeRedirectError('invalid_request', 'code_challenge_method must be S256.');
      }
      if (!params.code_challenge || !CODE_CHALLENGE_RE.test(params.code_challenge)) {
        throw new AuthorizeRedirectError('invalid_request', 'Invalid or missing code_challenge.');
      }

      const scope = this.validateScope(params.scope, client);
      const resource = await this.resolveResource(params.resource, client);
      const maxAge = this.parseMaxAge(params.max_age);
      const prompt = this.parsePrompt(params.prompt);

      // Session / interaction decision.
      const reauthRequired = prompt.has('login') || this.maxAgeExceeded(maxAge, session);
      const hasSession = session !== null && !reauthRequired;

      if (!hasSession) {
        if (prompt.has('none')) {
          // Non-interactive but we would need to show login => OAuth error, not a redirect to /login.
          throw new AuthorizeRedirectError('login_required', 'Authentication is required.');
        }
        const { requestId } = await this.createContext(
          'login',
          client,
          redirectUri,
          scope,
          resource,
          params,
          this.reauthAfter(prompt.has('login'), maxAge),
        );
        await this.recordAuthorize(client, audit, session?.userId, 'login_required');
        return { kind: 'login_required', requestId };
      }

      // DEBT-116 / §9.10 / INV-24: the signed-in user must be an ACTIVE member of the client's
      // tenant (taken from the client document only, never from the request/session). Checked
      // before consent and before prompt=none => consent_required. No membership is ever granted
      // here. `access_denied` is the same code as a user refusal: the RP learns no reason.
      await this.assertMember(session.userId, client, audit);

      // Signed in + request valid (B4.2, spec section 9.4). Decide consent.
      // The owner is `session.userId` (authenticated), never any client-supplied value.
      const requestedScopes = scope.split(' ').filter(Boolean);
      const versions = this.consents.currentVersions();
      const existing = await this.consents.find(session.userId, client.clientId, resource);
      const covered = this.consents.isCovered(existing, requestedScopes, versions);

      if (covered && !prompt.has('consent')) {
        // Consent already satisfied: issue a code now and redirect it to the RP. No screen, no
        // round-trip context needed -- every redirect param comes from the validated request here.
        const code = await this.issueCode(client, redirectUri, scope, resource, params, session);
        await this.recordAuthorize(client, audit, session.userId, 'code_issued');
        return { kind: 'code_issued', redirectUri, code, state: params.state };
      }

      // Consent needed (missing coverage or forced via prompt=consent).
      if (prompt.has('none')) {
        // Non-interactive but a consent screen would be required => OAuth error (fail-closed,
        // never auto-approve, never render UI) -- symmetric with login_required.
        throw new AuthorizeRedirectError('consent_required', 'User consent is required.');
      }
      // Persist the validated context so the POST /authorize/consent can resume it (single-use).
      const { requestId } = await this.createContext(
        'consent',
        client,
        redirectUri,
        scope,
        resource,
        params,
      );
      await this.recordAuthorize(client, audit, session.userId, 'consent_required');
      return {
        kind: 'consent_required',
        requestId,
        clientId: client.clientId,
        scopes: requestedScopes,
        resource: ConsentService.normalizeResource(resource),
        redirectUri,
      };
    } catch (err) {
      if (err instanceof AuthorizeRedirectError) {
        err.redirectUri = redirectUri;
        // A repeated `state` is never echoed: the IdP does not pick one of the RP's values.
        if (typeof params.state === 'string') err.state = params.state;
      }
      throw err;
    }
  }

  /**
   * Finalise a consent decision from POST /authorize/consent. Consume the single-use context by
   * `requestId`, then build the redirect purely from the stored context -- the POST body (except
   * `request_id`/`_csrf`) is never trusted for `redirect_uri`/`state`/`scope`/`resource`/`client_id`
   * (anti-param-tampering, symmetric with resume). Returns null when the context is missing/expired/
   * already consumed (replay) so the controller shows a first-party "expired" page (no redirect:
   * `redirect_uri` is gone with the context) — and, on approve, also when the client is now
   * disabled/gone or no longer registers the stored `redirect_uri`/allows the stored resource (B6.3a).
   *
   * `approve=false` (deny) redirects `access_denied` and writes NO consent and NO code. `approve=true`
   * records consent (owner = session.userId) and issues a code. The session is re-checked by the
   * caller before this runs; `session` here is the live, authenticated owner.
   */
  async decideConsent(
    requestId: string,
    approve: boolean,
    session: SessionView,
    audit: { ip?: string; userAgent?: string; requestId?: string } = {},
  ): Promise<{ redirectUri: string; code?: string; state?: string; denied?: boolean } | null> {
    const ctx = await this.contexts.consume(requestId);
    if (!ctx) return null;
    // Only a consent context (created with a live, sufficiently fresh session) can be decided here.
    // A login context -- notably a re-auth one (`prompt=login`/`max_age`, B6.2) -- must never mint
    // a code with the old session via this door (OIDC Core §3.1.2.1, INV-26). Already consumed, so
    // no loop; nothing is recorded and no code is issued.
    if (ctx.kind !== 'consent') {
      const err = new AuthorizeRedirectError('login_required', 'Re-authentication is required.');
      err.redirectUri = ctx.redirectUri;
      err.state = ctx.originalState;
      throw err;
    }

    if (!approve) {
      await this.recordConsent(ctx.clientId, audit, session.userId, 'denied');
      return { redirectUri: ctx.redirectUri, state: ctx.originalState, denied: true };
    }

    // The client could have changed between render and POST: re-resolve it and bound the granted
    // scopes by its *current* scopes so a scope the client has since lost is never carried forward.
    const client = await this.clients.findByClientId(ctx.clientId);
    // B6.3a: the client may have been disabled, or the admin may have removed the stored
    // redirect_uri / resource while this context waited (TTL <= 10'). Then the stored redirect_uri
    // is no longer trusted: first-party error page (null), no redirect there, no code minted.
    if (
      !client ||
      !isRegisteredRedirectUri(client.redirectUris, ctx.redirectUri) ||
      (ctx.resource !== undefined &&
        (adminTargetForbidden(client, ctx.resource, this.adminAud) ||
          (await this.resources.resolveForClient(client.allowedResources, ctx.resource)) === null))
    ) {
      return null;
    }
    // DEBT-116 (MT2): the membership may have been suspended/removed since the screen rendered.
    // Re-check against the re-resolved client's tenant BEFORE any consent write or code.
    try {
      await this.assertMember(session.userId, client, audit);
    } catch (err) {
      if (err instanceof AuthorizeRedirectError) {
        err.redirectUri = ctx.redirectUri;
        err.state = ctx.originalState;
      }
      throw err;
    }
    const requestedScopes = ctx.scope.split(' ').filter(Boolean);
    const versions = this.consents.currentVersions();
    await this.consents.grant(
      session.userId,
      client.clientId,
      ctx.resource,
      requestedScopes,
      versions,
      client.scopes,
    );
    const code = await this.issueCodeFromContext(ctx, session);
    await this.recordConsent(client.clientId, audit, session.userId, 'granted');
    return { redirectUri: ctx.redirectUri, code, state: ctx.originalState };
  }

  /** Mint an authorization code for a validated fresh request (covered path, no stored context). */
  private async issueCode(
    client: Client,
    redirectUri: string,
    scope: string,
    resource: string | undefined,
    params: AuthorizeParams,
    session: SessionView,
  ): Promise<string> {
    const { code } = await this.codes.create({
      clientId: client.clientId,
      redirectUri,
      codeChallenge: params.code_challenge!,
      resource,
      scope,
      nonce: params.nonce,
      userId: session.userId,
      authTime: session.authTime,
      sessionRef: session.ref,
      ...(session.amr ? { amr: session.amr } : {}),
    });
    // Track this RP against the session so a later logout can notify it (front-channel, B4.7).
    await this.sessions.recordClientForSession(session.ref, client.clientId);
    return code;
  }

  /** Mint an authorization code from a consumed context (approve path). */
  private async issueCodeFromContext(
    ctx: AuthorizeRequestContext,
    session: SessionView,
  ): Promise<string> {
    const { code } = await this.codes.create({
      clientId: ctx.clientId,
      redirectUri: ctx.redirectUri,
      codeChallenge: ctx.codeChallenge,
      resource: ctx.resource,
      scope: ctx.scope,
      nonce: ctx.nonce,
      userId: session.userId,
      authTime: session.authTime,
      sessionRef: session.ref,
      ...(session.amr ? { amr: session.amr } : {}),
    });
    // Track this RP against the session so a later logout can notify it (front-channel, B4.7).
    await this.sessions.recordClientForSession(session.ref, ctx.clientId);
    return code;
  }

  private async recordConsent(
    clientId: string,
    audit: { ip?: string; userAgent?: string; requestId?: string },
    userId: string,
    decision: 'granted' | 'denied',
  ): Promise<void> {
    await this.audit.record({
      actorType: 'user',
      actorId: userId,
      action:
        decision === 'granted'
          ? AuditAction.OAUTH_CONSENT_GRANTED
          : AuditAction.OAUTH_CONSENT_DENIED,
      clientId,
      ip: audit.ip,
      userAgent: audit.userAgent,
      requestId: audit.requestId,
      result: 'success',
    });
  }
  private async createContext(
    kind: AuthorizeRequestContext['kind'],
    client: Client,
    redirectUri: string,
    scope: string,
    resource: string | undefined,
    params: AuthorizeParams,
    reauthAfter?: number,
  ): Promise<{ requestId: string }> {
    const { requestId } = await this.contexts.create({
      kind,
      clientId: client.clientId,
      redirectUri,
      codeChallenge: params.code_challenge!,
      scope,
      resource,
      originalState: params.state,
      nonce: params.nonce,
      ...(reauthAfter !== undefined ? { reauthAfter } : {}),
    });
    return { requestId };
  }

  private validateScope(raw: string | undefined, client: Client): string {
    const requested = (raw ?? '').split(' ').filter(Boolean);
    if (requested.length === 0) {
      throw new AuthorizeRedirectError('invalid_scope', 'scope is required.');
    }
    const allowed = new Set(client.scopes);
    const unknown = requested.filter((s) => !allowed.has(s));
    if (unknown.length > 0) {
      throw new AuthorizeRedirectError(
        'invalid_scope',
        `Scope not allowed for this client: ${unknown.join(' ')}`,
      );
    }
    return requested.join(' ');
  }

  private async resolveResource(
    raw: string | undefined,
    client: Client,
  ): Promise<string | undefined> {
    if (raw === undefined) return undefined;
    // INV-15 (B7.1): a repeated `resource` query param arrives as an array; Mongoose would cast it
    // to `$in` and bind whichever resource matched first. One grant binds exactly one resource.
    if (typeof raw !== 'string') {
      throw new AuthorizeRedirectError('invalid_target', 'Only one resource parameter is allowed.');
    }
    try {
      // Map identifier (URI) -> resourceId -> allowedResources (never compare the URI directly).
      const resource = await this.resources.resolveForClient(client.allowedResources, raw);
      // DEBT-172/174: a non-admin-capable client never gets `aud=admin`, even if it lists `admin`.
      if (!resource || adminTargetForbidden(client, resource.identifier, this.adminAud)) {
        throw new AuthorizeRedirectError('invalid_target', 'Unknown or disallowed resource.');
      }
      return resource.identifier;
    } catch (err) {
      if (err instanceof InvalidResourceError) {
        throw new AuthorizeRedirectError('invalid_target', 'Malformed resource parameter.');
      }
      throw err;
    }
  }

  private parsePrompt(raw: string | undefined): Set<string> {
    const values = new Set((raw ?? '').split(' ').filter(Boolean));
    for (const v of values) {
      if (!['none', 'login', 'consent'].includes(v)) {
        throw new AuthorizeRedirectError('invalid_request', `Unsupported prompt value: ${v}`);
      }
    }
    if (values.has('none') && values.size > 1) {
      throw new AuthorizeRedirectError(
        'invalid_request',
        'prompt=none cannot be combined with other values.',
      );
    }
    return values;
  }

  private parseMaxAge(raw: string | undefined): number | undefined {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      throw new AuthorizeRedirectError(
        'invalid_request',
        'max_age must be a non-negative integer.',
      );
    }
    return n;
  }

  /**
   * DEBT-189 (F1): the instant a resumed session must have authenticated at/after -- the strictest
   * of `prompt=login` (now) and `max_age` (now - max_age), with or without a current session, so an
   * old upstream (federated) authentication can never satisfy `max_age`. undefined when neither.
   */
  private reauthAfter(promptLogin: boolean, maxAge: number | undefined): number | undefined {
    if (!promptLogin && maxAge === undefined) return undefined;
    const now = Date.now();
    return promptLogin ? now : now - maxAge! * 1000;
  }

  private maxAgeExceeded(maxAge: number | undefined, session: SessionView | null): boolean {
    if (maxAge === undefined || session === null) return false;
    const ageSec = (Date.now() - session.authTime) / 1000;
    // `max_age=0` always forces re-authentication (step-up hint, D3), even within the same ms.
    return maxAge === 0 || ageSec > maxAge;
  }

  /** Not an active member of `client.tenantId` => audited `access_denied`. A DB fault propagates. */
  private async assertMember(
    userId: string,
    client: Client,
    audit: { ip?: string; userAgent?: string; requestId?: string },
  ): Promise<void> {
    if (await this.memberships.isActiveMember(userId, client.tenantId)) return;
    await this.recordAuthorize(client, audit, userId, 'not_member', 'failure');
    throw new AuthorizeRedirectError('access_denied', 'Access denied.');
  }

  private async recordAuthorize(
    client: Client,
    audit: { ip?: string; userAgent?: string; requestId?: string },
    userId: string | undefined,
    outcome: string,
    result: 'success' | 'failure' = 'success',
  ): Promise<void> {
    // Never log code_challenge / nonce / state (INV-20, tech-lead C7).
    await this.audit.record({
      actorType: userId ? 'user' : 'system',
      actorId: userId,
      tenantId: client.tenantId,
      action: AuditAction.OAUTH_AUTHORIZE,
      clientId: client.clientId,
      ip: audit.ip,
      userAgent: audit.userAgent,
      requestId: audit.requestId,
      result,
      ...(result === 'failure' ? { reason: outcome } : {}),
      metadata: { outcome },
    });
  }
}
