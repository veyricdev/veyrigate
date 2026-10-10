import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import type { AppConfig, TokenConfig } from '../../../config/configuration';
import { generateToken, sha256 } from '../../../common/crypto/crypto.util';
import { TokenSigner } from '../../keys/token-signer';
import { AuditAction } from '../../security/audit/audit-action.enum';
import { AuditService } from '../../security/audit/audit.service';
import type { Client } from '../../clients/client.service';
import type { AuthorizationCodeData } from '../code/authorization-code.service';
import { TokenError } from './token.errors';

/**
 * amr/acr are hard-coded for M3: the only way to establish a session today is email/password,
 * with no MFA. This is WRONG once federation lands ? B5 must carry `amr` from the session into
 * the authorization code and then into the token (DEBT-030). Never read `amr` from the request.
 */
const DEFAULT_AMR = ['pwd'] as const;
const DEFAULT_ACR = 'urn:idp:aal1';

/**
 * The admin API's resource identifier (D3/D6), derived from the configured issuer so it lives in
 * exactly one place for B6.1/B6.2 to reuse. ISSUER=http://localhost:4000 => http://localhost:4000/admin/.
 */
export function adminResourceIdentifier(issuer: string): string {
  return new URL('/admin/', issuer).href;
}

/** The successful `/token` response body (RFC 6749 ?5.1 + OIDC). */
export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
  id_token?: string;
  refresh_token?: string;
}

/**
 * `/token` grant `authorization_code` (B4.4, spec ?8/?9.3/?9.5).
 *
 * Builds and signs the access token (`aud` = the resource bound in the code, never from the
 * request body), the ID token (only when scope contains `openid`), and ? only when D7 is
 * satisfied ? mints and stores a minimal RefreshToken (B4.5 adds rotation/reuse/revoke).
 * Pure claim shaping is kept in private helpers so the HTTP layer stays thin.
 */
@Injectable()
export class TokenService {
  private readonly issuer: string;
  private readonly accessTokenTtl: number;
  private readonly refreshTokenTtl: number;
  private readonly adminResource: string;

  constructor(
    @InjectModel('RefreshToken') private readonly refreshTokens: Model<Record<string, unknown>>,
    private readonly signer: TokenSigner,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.issuer = config.getOrThrow<AppConfig>('app').issuer;
    const token = config.getOrThrow<TokenConfig>('token');
    this.accessTokenTtl = token.accessTokenTtl;
    this.refreshTokenTtl = token.refreshTokenTtl;
    this.adminResource = adminResourceIdentifier(this.issuer);
  }

  /**
   * Issue tokens for a consumed authorization code. `client` is the authenticated client; `data`
   * is the context the code was bound to (resource/scope/userId/nonce/authTime). Throws
   * `TokenError` for domain failures; lets infrastructure errors (sign/DB/audit) propagate so the
   * controller returns a fail-closed 500 without a partially issued token.
   */
  async issueForAuthorizationCode(
    client: Client,
    data: AuthorizationCodeData,
    audit: { ip?: string; userAgent?: string; requestId?: string } = {},
  ): Promise<TokenResponse> {
    // An access token must target a concrete resource; a code with no bound resource (the public
    // client case) cannot mint one, and RefreshToken.resource is schema-required (fail-closed).
    if (!data.resource) {
      throw new TokenError('invalid_target');
    }
    const resource = data.resource;
    const scope = data.scope;
    const scopes = scope.length ? scope.split(' ') : [];
    const authTimeSec =
      typeof data.authTime === 'number' ? Math.floor(data.authTime / 1000) : undefined;

    const accessToken = await this.signAccessToken(
      data.userId,
      resource,
      scope,
      client.clientId,
      authTimeSec,
    );
    const idToken = scopes.includes('openid')
      ? await this.signIdToken(
          { userId: data.userId, nonce: data.nonce },
          client.clientId,
          authTimeSec,
        )
      : undefined;

    const issueRefresh =
      client.grantTypes.includes('refresh_token') && scopes.includes('offline_access');
    let refreshToken: string | undefined;
    if (issueRefresh) {
      // First token of a new family (parentId=null); absolute lifetime now + refreshTokenTtl (Q6).
      const now = new Date();
      const minted = await this.insertRefreshToken({
        userId: data.userId,
        clientId: client.clientId,
        scope: scopes,
        resource,
        familyId: randomUUID(),
        parentId: null,
        issuedAt: now,
        expiresAt: new Date(now.getTime() + this.refreshTokenTtl * 1000),
        ip: audit.ip,
        userAgent: audit.userAgent,
      });
      refreshToken = minted.token;
    }

    // Audit before returning (INV-25): a failed write throws => no token reaches the client
    // (fail-closed, same pattern as SESSION_CREATED). Metadata carries no secret/token/code.
    await this.audit.record({
      actorType: 'user',
      actorId: data.userId,
      clientId: client.clientId,
      action: AuditAction.TOKEN_ISSUED,
      result: 'success',
      ip: audit.ip,
      userAgent: audit.userAgent,
      requestId: audit.requestId,
      metadata: { resource, scope, refresh: issueRefresh },
    });

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.accessTokenTtl,
      scope,
      ...(idToken ? { id_token: idToken } : {}),
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
    };
  }

  /**
   * Sign the access token (+ ID token when the effective scope contains `openid`) for a
   * refresh-token grant (B4.5). `effectiveScope` is the already-validated scope for the access
   * token (original scope, or a narrowed subset the client asked for); `resource` is bound to the
   * original grant. A refresh-issued ID token has no `nonce`/`auth_time`, and an admin-resource
   * access token has no `auth_time` either (the RefreshToken stores neither) — step-up stays
   * fail-closed. `RefreshTokenService` owns the rotation/audit; this method only shapes claims.
   */
  async signTokensForRefresh(input: {
    userId: string;
    clientId: string;
    resource: string;
    effectiveScope: string[];
  }): Promise<{ accessToken: string; idToken?: string }> {
    const scope = input.effectiveScope.join(' ');
    const accessToken = await this.signAccessToken(
      input.userId,
      input.resource,
      scope,
      input.clientId,
      undefined,
    );
    const idToken = input.effectiveScope.includes('openid')
      ? await this.signIdToken({ userId: input.userId }, input.clientId, undefined)
      : undefined;
    return { accessToken, ...(idToken ? { idToken } : {}) };
  }

  /** Access-token lifetime in seconds (for the refresh grant's `expires_in`). */
  get accessTokenLifetime(): number {
    return this.accessTokenTtl;
  }

  private signAccessToken(
    userId: string,
    resource: string,
    scope: string,
    clientId: string,
    authTimeSec: number | undefined,
  ): Promise<string> {
    const claims: Record<string, unknown> = { scope, client_id: clientId };
    // auth_time only when the resource is the admin API (D3) AND the code carried it (B6.2 step-up
    // stays fail-closed when it is absent ? never fabricate `now`).
    if (resource === this.adminResource && authTimeSec !== undefined) {
      claims.auth_time = authTimeSec;
    }
    return this.signer.sign(claims, {
      audience: resource,
      subject: userId,
      expiresInSec: this.accessTokenTtl,
    });
  }

  /**
   * Sign an ID token. Takes only what the claims need (`userId`, optional `nonce`/`authTime`) so
   * both the authorization_code grant and the refresh grant can call it. A refresh-issued ID
   * token carries neither `nonce` nor `auth_time` (the RefreshToken document stores neither), so
   * B6.2 step-up stays fail-closed — never fabricate `now` (OIDC Core §12.2).
   */
  private signIdToken(
    subject: { userId: string; nonce?: string },
    clientId: string,
    authTimeSec: number | undefined,
  ): Promise<string> {
    const claims: Record<string, unknown> = {
      amr: [...DEFAULT_AMR],
      acr: DEFAULT_ACR,
    };
    // `nonce` is carried through byte-for-byte when present; never fabricated (RP owns it).
    if (subject.nonce !== undefined) {
      claims.nonce = subject.nonce;
    }
    if (authTimeSec !== undefined) {
      claims.auth_time = authTimeSec;
    }
    return this.signer.sign(claims, {
      audience: clientId,
      subject: subject.userId,
      expiresInSec: this.accessTokenTtl,
    });
  }

  /**
   * The single place that creates a RefreshToken document (B4.4 first token + B4.5 rotation
   * descendant use the same path). The caller supplies `familyId`/`parentId`/`expiresAt` so the
   * descendant inherits the family and the original absolute lifetime (no sliding, Q6). The
   * caller may pass a pre-generated `_id` so a parent can link `replacedBy` to its successor. The
   * plaintext token is returned once and only its sha256 hash is stored (INV-10).
   */
  async insertRefreshToken(input: {
    userId: string;
    clientId: string;
    scope: string[];
    resource: string;
    familyId: string;
    parentId: Types.ObjectId | null;
    issuedAt: Date;
    expiresAt: Date;
    _id?: Types.ObjectId;
    ip?: string;
    userAgent?: string;
  }): Promise<{ token: string; _id: Types.ObjectId }> {
    const token = generateToken();
    const _id = input._id ?? new Types.ObjectId();
    await this.refreshTokens.create({
      _id,
      tokenHash: sha256(token),
      familyId: input.familyId,
      parentId: input.parentId,
      userId: new Types.ObjectId(input.userId),
      clientId: input.clientId,
      scope: input.scope,
      resource: input.resource,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      ...(input.ip !== undefined ? { ip: input.ip } : {}),
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
    });
    return { token, _id };
  }
}
