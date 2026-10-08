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
import { AuthorizeRequestContextService } from './authorize-request-context.service';

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
}

/**
 * Outcome of `/authorize` for B4.1. This task stops at the point where a code would be issued
 * (B4.3/B4.4) — it never issues a code or token. The controller turns each outcome into an HTTP
 * response.
 */
export type AuthorizeOutcome =
  /** Not signed in (and interaction allowed): send the user to the login page, resumable via requestId. */
  | { kind: 'login_required'; requestId: string }
  /**
   * Signed in and request valid. Consent handling is B4.2; B4.1 stops here with a validated
   * context ready for the code-issuance step (B4.3/B4.4).
   */
  | { kind: 'ready'; requestId: string; userId: string };

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

  constructor(
    private readonly clients: ClientService,
    private readonly resources: ResourceService,
    private readonly contexts: AuthorizeRequestContextService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.issuer = config.getOrThrow<AppConfig>('app').issuer;
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
    if (!ctx) return null;
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
          client,
          redirectUri,
          scope,
          resource,
          params,
        );
        await this.recordAuthorize(client, audit, session?.userId, 'login_required');
        return { kind: 'login_required', requestId };
      }

      // Signed in. Consent handling is B4.2; `prompt=consent` / `consent_required` for `prompt=none`
      // are decided there. B4.1 stops at a validated, ready context.
      // TODO(B4.2): check Consent coverage here; `prompt=none` + missing consent => consent_required.
      const { requestId } = await this.createContext(client, redirectUri, scope, resource, params);
      await this.recordAuthorize(client, audit, session.userId, 'ready');
      return { kind: 'ready', requestId, userId: session.userId };
    } catch (err) {
      if (err instanceof AuthorizeRedirectError) {
        err.redirectUri = redirectUri;
        err.state = params.state;
      }
      throw err;
    }
  }

  private async createContext(
    client: Client,
    redirectUri: string,
    scope: string,
    resource: string | undefined,
    params: AuthorizeParams,
  ): Promise<{ requestId: string }> {
    const { requestId } = await this.contexts.create({
      clientId: client.clientId,
      redirectUri,
      codeChallenge: params.code_challenge!,
      scope,
      resource,
      originalState: params.state,
      nonce: params.nonce,
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
    try {
      // Map identifier (URI) -> resourceId -> allowedResources (never compare the URI directly).
      const resource = await this.resources.resolveForClient(client.allowedResources, raw);
      if (!resource) {
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

  private maxAgeExceeded(maxAge: number | undefined, session: SessionView | null): boolean {
    if (maxAge === undefined || session === null) return false;
    const ageSec = (Date.now() - session.authTime) / 1000;
    return ageSec > maxAge;
  }

  private async recordAuthorize(
    client: Client,
    audit: { ip?: string; userAgent?: string; requestId?: string },
    userId: string | undefined,
    outcome: string,
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
      result: 'success',
      metadata: { outcome },
    });
  }
}
