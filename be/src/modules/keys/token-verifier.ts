import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createLocalJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { AppConfig } from '../../config/configuration';
import { KEY_PROVIDER, type KeyProvider } from './key-provider';

/** A verified access token (RFC 9068): `aud` is always a single string (the bound resource). */
export interface AccessTokenClaims extends JWTPayload {
  sub: string;
  aud: string;
  jti: string;
  client_id: string;
  scope: string;
  exp: number;
  iat: number;
}

/**
 * Verifies JWTs against the current JWKS (so an emergency rotation takes effect
 * immediately). Checks signature, `iss`, `aud`, `exp` (required); only RS256 is accepted
 * (no `none`/HS* algorithm confusion). Throws on any failure.
 */
@Injectable()
export class TokenVerifier {
  private readonly issuer: string;

  constructor(
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    config: ConfigService,
  ) {
    this.issuer = config.getOrThrow<AppConfig>('app').issuer;
  }

  async verify(token: string, audience: string): Promise<JWTPayload> {
    const jwks = createLocalJWKSet({ keys: await this.keys.getPublicKeys() });
    const { payload } = await jwtVerify(token, jwks, {
      issuer: this.issuer,
      audience,
      algorithms: ['RS256'],
      // jose only checks `exp` when present — a token without it must not verify forever.
      requiredClaims: ['exp'],
    });
    return payload;
  }

  /**
   * Verify an access token (RFC 9068) WITHOUT pinning a single `aud`: used by `/userinfo` and
   * `/introspect`, which accept an access token for any resource the caller is allowed (the caller
   * enforces `aud ∈ allowedResources` after this returns). Rejects anything that is not a genuine
   * access token: RS256 only, `iss` must match, header `typ` must be `at+jwt` (an ID token — same
   * signer, `typ: JWT` — fails here, closing token confusion), and the self-contained claims
   * `exp,iat,sub,jti,client_id,scope` must all be present with `aud` a single string. Throws on any
   * failure so the caller can map it to 401 / `active:false` (never 500).
   */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    const jwks = createLocalJWKSet({ keys: await this.keys.getPublicKeys() });
    const { payload } = await jwtVerify(token, jwks, {
      issuer: this.issuer,
      algorithms: ['RS256'],
      typ: 'at+jwt',
      requiredClaims: ['exp', 'iat', 'sub', 'jti', 'client_id', 'scope'],
    });
    // A multi-valued `aud` is not an access token this IdP issued (`signAccessToken` sets a single
    // resource); reject rather than guess which entry to trust. The remaining self-contained claims
    // must be strings too: a non-string `scope`/`client_id`/`sub`/`jti` (only reachable with a valid
    // IdP signature, so low risk) must fail HERE — otherwise `claims.scope.split` would throw a
    // TypeError (500) and a non-string `client_id` would leak into a DB query as a 401-vs-500 split.
    if (
      typeof payload.aud !== 'string' ||
      typeof payload.sub !== 'string' ||
      typeof payload.client_id !== 'string' ||
      typeof payload.scope !== 'string' ||
      typeof payload.jti !== 'string'
    ) {
      throw new Error('access token aud/sub/client_id/scope/jti must each be a single string');
    }
    return payload as AccessTokenClaims;
  }
}
