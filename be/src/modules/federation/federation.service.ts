import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { constantTimeEqual, generateToken, sha256 } from '../../common/crypto/crypto.util';
import { deriveS256Challenge } from '../../common/crypto/pkce.util';
import { safeCspOrigin } from '../../common/http/csp';
import type { AppConfig } from '../../config/configuration';
import { AuthenticationService } from '../authentication/authentication.service';
import { FederatedIdentityService } from '../identity/federated-identity.service';
import { DuplicateError } from '../identity/identity.errors';
import { DEFAULT_TENANT_ID } from '../identity/tenant.service';
import { UserTenantService } from '../identity/user-tenant.service';
import { normalizeEmail, UserService } from '../identity/user.service';
import { AuthorizeRequestContextService } from '../oauth/authorize/authorize-request-context.service';
import { AuditAction } from '../security/audit/audit-action.enum';
import { AuditService } from '../security/audit/audit.service';
import { SessionService } from '../sessions/session.service';
import { buildAuthorizeUrl, exchangeCode, type ProviderIdentity } from './federation.client';
import { FederationError } from './federation.errors';
import { FederationStateStore, type FederationLinkRecord } from './federation-state.store';
import {
  enabledProvider,
  FEDERATION_PROVIDERS,
  type FederationProvider,
  type FederationProviders,
  type ProviderName,
} from './providers';

/**
 * Session `authTime` from the provider's own `auth_time` (DEBT-189 F3), clamped to
 * `[reauthAfter, now]`: the lower bound only absorbs the <= 60s skew `verifyGoogleIdToken` already
 * tolerated (else resume would answer `login_required`), the upper bound refuses a future time.
 * No `auth_time` (GitHub, or Google unasked) => now (known limit, DEBT-192).
 */
function upstreamAuthTime(identity: ProviderIdentity, reauthAfter: number | undefined): number {
  const now = Date.now();
  if (identity.authTime === undefined) return now;
  return Math.min(now, Math.max(identity.authTime * 1000, reauthAfter ?? -Infinity));
}

export interface FederationAuditContext {
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

export interface CallbackQuery {
  state?: string;
  code?: string;
  error?: string;
  iss?: string;
}

export type CallbackOutcome =
  /** Signed in: set the session cookie and 302 to the resumable `/authorize?request_id`. */
  | { kind: 'signed_in'; sessionId: string; location: string }
  /** The provider returned `error` (e.g. access_denied): offer to go back to the login page. */
  | { kind: 'denied'; loginUrl: string }
  /** Verified email of an existing local account (B5.3): set `idp_link`, 302 `/auth/link`. */
  | { kind: 'link_required'; linkToken: string };

export type LinkOutcome =
  /** Linked: set the session cookie, 302 to the resumable `/authorize?request_id`. */
  | { kind: 'linked'; sessionId: string; location: string }
  /** Pending gone/replayed, binding mismatch or bad credentials: nothing linked, no session. */
  | { kind: 'failed'; loginUrl: string }
  /** Password login succeeded but the link was refused (other user / duplicate): session, no link. */
  | { kind: 'not_linked'; sessionId: string; location: string };

const resumeUrl = (requestId: string) => `/authorize?request_id=${encodeURIComponent(requestId)}`;
/** `/login` fallback that still resumes the (only peeked) context. */
const loginUrlFor = (requestId: string) =>
  `/login?returnTo=${encodeURIComponent(resumeUrl(requestId))}`;

/**
 * Identity broker (B5.2, spec §9.9). The IdP's own `state` (bound to `request_id`, PKCE verifier,
 * nonce and the `idp_fed` browser cookie) protects the provider leg; after a verified identity it
 * establishes an IdP session and hands back to the existing `/authorize?request_id` resume, which
 * consumes the context, re-checks `reauthAfter`, consent and echoes the RP `state`. This service
 * never consumes the `AuthorizeRequestContext` and never redirects to an RP.
 */
@Injectable()
export class FederationService {
  private readonly issuer: string;
  private readonly logger = new Logger(FederationService.name);

  constructor(
    @Inject(FEDERATION_PROVIDERS) private readonly providers: FederationProviders,
    private readonly states: FederationStateStore,
    private readonly contexts: AuthorizeRequestContextService,
    private readonly users: UserService,
    private readonly memberships: UserTenantService,
    private readonly identities: FederatedIdentityService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly auth: AuthenticationService,
    config: ConfigService,
  ) {
    this.issuer = config.getOrThrow<AppConfig>('app').issuer;
  }

  /** Enabled provider by route name, else `not_found` (404). */
  provider(name: string): FederationProvider {
    const provider = enabledProvider(this.providers, name);
    if (!provider) throw new FederationError('not_found');
    return provider;
  }

  /** Begin a provider leg for a live login context; returns the provider authorize URL. */
  async start(name: string, requestId: string | undefined, bindingCookie: string): Promise<string> {
    const provider = this.provider(name);
    const ctx = requestId ? await this.contexts.peek(requestId) : null;
    if (!requestId || !ctx || ctx.kind !== 'login') throw new FederationError('context_expired');
    const reauthAfter = ctx.reauthAfter;
    // GitHub cannot be forced to re-authenticate (`prompt=login` or any `max_age`): refuse instead
    // of trusting its SSO (F8, DEBT-183/189).
    if (reauthAfter !== undefined && provider.name === 'github') {
      throw new FederationError('reauth_required');
    }
    const codeVerifier = generateToken();
    const nonce = generateToken();
    const state = await this.states.create({
      provider: provider.name,
      requestId,
      codeVerifier,
      nonce,
      bindingHash: sha256(bindingCookie),
      ...(reauthAfter !== undefined ? { reauthAfter } : {}),
    });
    return buildAuthorizeUrl(provider, {
      state,
      nonce,
      codeChallenge: deriveS256Challenge(codeVerifier),
      redirectUri: this.redirectUri(provider.name),
      reauthAfter,
    });
  }

  async callback(
    name: string,
    query: CallbackQuery,
    cookies: { binding?: string; session?: string },
    audit: FederationAuditContext,
  ): Promise<CallbackOutcome> {
    const provider = this.provider(name);
    // Single-use FIRST (F6): whatever fails below, this state is already dead.
    const record = query.state ? await this.states.consume(query.state) : null;
    if (
      !record ||
      record.provider !== provider.name ||
      !cookies.binding ||
      !constantTimeEqual(sha256(cookies.binding), record.bindingHash) ||
      (provider.name === 'google' &&
        query.iss !== undefined &&
        !provider.issuers.includes(query.iss))
    ) {
      throw new FederationError('invalid_state');
    }
    if (query.error !== undefined) {
      // The context was only peeked, so the user can still finish with another method.
      return { kind: 'denied', loginUrl: loginUrlFor(record.requestId) };
    }
    if (!query.code) throw new FederationError('provider_unavailable');

    const identity = await exchangeCode(provider, {
      code: query.code,
      codeVerifier: record.codeVerifier,
      nonce: record.nonce,
      redirectUri: this.redirectUri(provider.name),
      ...(record.reauthAfter !== undefined ? { reauthSince: record.reauthAfter } : {}),
    });
    const { userId, newUser, link } = await this.resolveUser(provider.name, identity, audit);
    if (link) {
      // B5.3 (F6): no FI, no session yet — the local account's password must be proven first.
      const linkToken = await this.states.createLink({
        provider: provider.name,
        providerId: identity.providerId,
        email: normalizeEmail(identity.email!),
        userId,
        requestId: record.requestId,
        bindingHash: record.bindingHash,
      });
      return { kind: 'link_required', linkToken };
    }
    await this.identities.touchLastLogin(provider.name, identity.providerId);

    const established = await this.sessions.establish(cookies.session, userId, DEFAULT_TENANT_ID, {
      amr: ['fed'],
      authTime: upstreamAuthTime(identity, record.reauthAfter),
    });
    await this.audit.record({
      actorType: 'user',
      actorId: userId,
      action: AuditAction.AUTH_LOGIN_SUCCESS,
      result: 'success',
      ip: audit.ip,
      userAgent: audit.userAgent,
      requestId: audit.requestId,
      metadata: { provider: provider.name, newUser },
    });
    await this.audit.record({
      actorType: 'user',
      actorId: userId,
      action: AuditAction.SESSION_CREATED,
      targetType: 'session',
      targetId: established.session.ref,
      result: 'success',
      metadata: { provider: provider.name },
    });
    return { kind: 'signed_in', sessionId: established.id, location: resumeUrl(record.requestId) };
  }

  /** Pending link for the `idp_link` token (peek only); null when missing/expired. */
  pendingLink(token: string | undefined): Promise<FederationLinkRecord | null> {
    return this.states.peekLink(token);
  }

  /**
   * `GET /auth/link` (F7): the pending link, only for the browser that ran the provider leg
   * (`idp_fed` binding, constant-time). Missing/expired/foreign => `invalid_state`.
   */
  async linkPage(
    token: string | undefined,
    binding: string | undefined,
  ): Promise<{
    provider: ProviderName;
    email: string;
    loginUrl: string;
    /** RP origin for the page's CSP `form-action` (DEBT-084); null => `'self'` only. */
    formAction: string | null;
  }> {
    const pending = await this.states.peekLink(token);
    if (!pending || !binding || !constantTimeEqual(sha256(binding), pending.bindingHash)) {
      throw new FederationError('invalid_state');
    }
    let formAction: string | null = null;
    try {
      formAction = safeCspOrigin((await this.contexts.peek(pending.requestId))?.redirectUri);
    } catch {
      // Fail-closed: no guessed origin. Never log the request_id.
      this.logger.warn('federation link: context peek failed; keeping form-action self');
    }
    return {
      provider: pending.provider,
      email: pending.email,
      loginUrl: loginUrlFor(pending.requestId),
      formAction,
    };
  }

  /**
   * `POST /auth/link` (F8, INV-22). Consume FIRST (single-use: even a wrong password burns the
   * pending link), then the `idp_fed` binding, then the local password login of the PENDING email
   * (exactly `/login`: generic error, failure counter/lock, unverified email refused), then the
   * signed-in user must be the account the email belonged to at callback time. Only then the
   * `FederatedIdentity` is written and `ACCOUNT_LINKED` audited.
   */
  async completeLink(
    token: string | undefined,
    binding: string | undefined,
    password: string,
    ctx: FederationAuditContext & { oldSessionId?: string },
  ): Promise<LinkOutcome> {
    const pending = await this.states.consumeLink(token);
    if (!pending) return this.linkFailed('link_missing', '/login');
    const loginUrl = loginUrlFor(pending.requestId);
    if (!binding || !constantTimeEqual(sha256(binding), pending.bindingHash)) {
      return this.linkFailed('binding', loginUrl);
    }
    let established: Awaited<ReturnType<AuthenticationService['login']>>;
    try {
      established = await this.auth.login(pending.email, password, ctx);
    } catch (err) {
      if (!(err instanceof UnauthorizedException)) throw err;
      return this.linkFailed('credentials', loginUrl);
    }
    // From here a new session exists (the old one was rotated away): always hand it back.
    const signedIn = { sessionId: established.id, location: resumeUrl(pending.requestId) };
    if (established.session.userId !== pending.userId) {
      this.logger.warn('federation link failed: user_mismatch');
      return { kind: 'not_linked', ...signedIn };
    }
    try {
      await this.identities.link({
        userId: pending.userId,
        provider: pending.provider,
        providerId: pending.providerId,
        email: pending.email,
        emailVerified: true,
      });
    } catch (err) {
      if (!(err instanceof DuplicateError)) throw err;
      this.logger.warn('federation link failed: duplicate');
      return { kind: 'not_linked', ...signedIn };
    }
    await this.audit.record({
      actorType: 'user',
      actorId: pending.userId,
      action: AuditAction.ACCOUNT_LINKED,
      targetType: 'user',
      targetId: pending.userId,
      result: 'success',
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
      metadata: { provider: pending.provider },
    });
    return { kind: 'linked', ...signedIn };
  }

  private linkFailed(code: string, loginUrl: string): LinkOutcome {
    this.logger.warn(`federation link failed: ${code}`);
    return { kind: 'failed', loginUrl };
  }

  private redirectUri(name: ProviderName): string {
    // From the configured issuer, never the Host header (F2).
    return new URL(`/auth/${name}/callback`, this.issuer).href;
  }

  /**
   * Map a verified external identity to a local user (F7). Lookup strictly by
   * `(provider, providerId)`; never auto-link on email (INV-22): a verified email of an existing
   * account answers `link: true` (B5.3: the password must be proven first). Provisioning is ordered
   * User -> membership -> FederatedIdentity with compensation (no Mongo transactions here).
   */
  private async resolveUser(
    provider: ProviderName,
    identity: ProviderIdentity,
    audit: FederationAuditContext,
  ): Promise<{ userId: string; newUser: boolean; link?: true }> {
    const existing = await this.identities.findByProvider(provider, identity.providerId);
    if (existing) {
      return {
        userId: await this.loginExisting(provider, String(existing.userId), audit),
        newUser: false,
      };
    }
    // F5: no verified email => stop BEFORE any lookup by email (an unverified one never probes).
    if (!identity.email) throw new FederationError('email_unverified');
    const email = normalizeEmail(identity.email);
    const local = await this.users.findByEmail(email);
    if (local) {
      // A parallel callback of this very identity may have just linked it: lookup by providerId
      // only (never by email), so this cannot attach the identity to a foreign account.
      const linked = await this.identities.findByProvider(provider, identity.providerId);
      if (linked) {
        return {
          userId: await this.loginExisting(provider, String(linked.userId), audit),
          newUser: false,
        };
      }
      // No lock/password/verified check here (F5/F9): the link step fails generically instead.
      return { userId: local.sub, newUser: false, link: true };
    }

    let userId: string;
    try {
      userId = (await this.users.create({ email, emailVerifiedAt: new Date() })).sub;
    } catch (err) {
      if (!(err instanceof DuplicateError)) throw err;
      // Same email created concurrently (a parallel callback for this identity, or a register).
      return this.afterLostRace(provider, identity, audit);
    }
    try {
      await this.memberships.addMembership(userId, DEFAULT_TENANT_ID);
      await this.identities.link({
        userId,
        provider,
        providerId: identity.providerId,
        email,
        emailVerified: true,
      });
    } catch (err) {
      // Undo what THIS request created so no orphan user survives (F7), then defer to the winner.
      // DEBT-190 (F15): both undo steps always run and never mask the original error.
      const undo = await Promise.allSettled([
        this.memberships.deleteMembership(userId, DEFAULT_TENANT_ID),
        this.users.deleteById(userId),
      ]);
      if (undo.some((r) => r.status === 'rejected')) {
        this.logger.error('federation provisioning compensation failed');
      }
      if (!(err instanceof DuplicateError)) throw err;
      return this.afterLostRace(provider, identity, audit);
    }
    return { userId, newUser: true };
  }

  /** After a lost provisioning race: sign in the winner's user, or ask to retry (nothing linked). */
  private async afterLostRace(
    provider: ProviderName,
    identity: ProviderIdentity,
    audit: FederationAuditContext,
  ): Promise<{ userId: string; newUser: boolean }> {
    const winner = await this.identities.findByProvider(provider, identity.providerId);
    if (!winner) throw new FederationError('retry');
    return {
      userId: await this.loginExisting(provider, String(winner.userId), audit),
      newUser: false,
    };
  }

  /** An already-linked user: must still exist and not be locked (admin or brute-force). */
  private async loginExisting(
    provider: ProviderName,
    userId: string,
    audit: FederationAuditContext,
  ): Promise<string> {
    const user = await this.users.findById(userId);
    // A FederatedIdentity whose user is gone is never silently re-provisioned (fail-closed).
    if (!user) throw new FederationError('invalid_identity');
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.recordFailed(provider, 'locked', audit, userId);
      throw new FederationError('account_locked');
    }
    return userId;
  }

  private recordFailed(
    provider: ProviderName,
    reason: string,
    audit: FederationAuditContext,
    userId?: string,
  ) {
    return this.audit.record({
      actorType: 'system',
      ...(userId ? { targetType: 'user', targetId: userId } : {}),
      action: AuditAction.AUTH_LOGIN_FAILED,
      result: 'failure',
      reason,
      ip: audit.ip,
      userAgent: audit.userAgent,
      requestId: audit.requestId,
      metadata: { provider },
    });
  }
}
