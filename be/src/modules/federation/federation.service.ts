import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { constantTimeEqual, generateToken, sha256 } from '../../common/crypto/crypto.util';
import { deriveS256Challenge } from '../../common/crypto/pkce.util';
import type { AppConfig } from '../../config/configuration';
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
import { FederationStateStore } from './federation-state.store';
import {
  enabledProvider,
  FEDERATION_PROVIDERS,
  type FederationProvider,
  type FederationProviders,
  type ProviderName,
} from './providers';

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
  | { kind: 'denied'; loginUrl: string };

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

  constructor(
    @Inject(FEDERATION_PROVIDERS) private readonly providers: FederationProviders,
    private readonly states: FederationStateStore,
    private readonly contexts: AuthorizeRequestContextService,
    private readonly users: UserService,
    private readonly memberships: UserTenantService,
    private readonly identities: FederatedIdentityService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
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
    const reauth = ctx.reauthAfter !== undefined;
    // GitHub cannot be forced to re-authenticate: refuse instead of trusting its SSO (F8, DEBT-183).
    if (reauth && provider.name === 'github') throw new FederationError('reauth_required');
    const codeVerifier = generateToken();
    const nonce = generateToken();
    const state = await this.states.create({
      provider: provider.name,
      requestId,
      codeVerifier,
      nonce,
      bindingHash: sha256(bindingCookie),
      reauth,
    });
    return buildAuthorizeUrl(provider, {
      state,
      nonce,
      codeChallenge: deriveS256Challenge(codeVerifier),
      redirectUri: this.redirectUri(provider.name),
      reauth,
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
    const resume = `/authorize?request_id=${encodeURIComponent(record.requestId)}`;
    if (query.error !== undefined) {
      // The context was only peeked, so the user can still finish with another method.
      return { kind: 'denied', loginUrl: `/login?returnTo=${encodeURIComponent(resume)}` };
    }
    if (!query.code) throw new FederationError('provider_unavailable');

    const identity = await exchangeCode(provider, {
      code: query.code,
      codeVerifier: record.codeVerifier,
      nonce: record.nonce,
      redirectUri: this.redirectUri(provider.name),
      ...(record.reauth ? { reauthSince: record.createdAt } : {}),
    });
    const { userId, newUser } = await this.resolveUser(provider.name, identity, audit);
    await this.identities.touchLastLogin(provider.name, identity.providerId);

    const established = await this.sessions.establish(cookies.session, userId, DEFAULT_TENANT_ID, {
      amr: ['fed'],
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
    return { kind: 'signed_in', sessionId: established.id, location: resume };
  }

  private redirectUri(name: ProviderName): string {
    // From the configured issuer, never the Host header (F2).
    return new URL(`/auth/${name}/callback`, this.issuer).href;
  }

  /**
   * Map a verified external identity to a local user (F7). Lookup strictly by
   * `(provider, providerId)`; never auto-link on email (INV-22, B5.3). Provisioning is ordered
   * User -> membership -> FederatedIdentity with compensation (no Mongo transactions here).
   */
  private async resolveUser(
    provider: ProviderName,
    identity: ProviderIdentity,
    audit: FederationAuditContext,
  ): Promise<{ userId: string; newUser: boolean }> {
    const existing = await this.identities.findByProvider(provider, identity.providerId);
    if (existing) {
      return {
        userId: await this.loginExisting(provider, String(existing.userId), audit),
        newUser: false,
      };
    }
    if (!identity.email) throw new FederationError('email_unverified');
    const email = normalizeEmail(identity.email);
    if (await this.users.findByEmail(email)) {
      // A parallel callback of this very identity may have just linked it: lookup by providerId
      // only (never by email), so this cannot attach the identity to a foreign account.
      const linked = await this.identities.findByProvider(provider, identity.providerId);
      if (linked) {
        return {
          userId: await this.loginExisting(provider, String(linked.userId), audit),
          newUser: false,
        };
      }
      await this.recordFailed(provider, 'federated_email_conflict', audit);
      throw new FederationError('email_conflict');
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
      await this.memberships.deleteMembership(userId, DEFAULT_TENANT_ID);
      await this.users.deleteById(userId);
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
