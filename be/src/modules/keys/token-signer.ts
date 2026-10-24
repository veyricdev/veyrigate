import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { JWTPayload } from 'jose';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config/configuration';
import { KEY_PROVIDER, type KeyProvider } from './key-provider';

export interface SignOptions {
  audience: string;
  subject?: string;
  expiresInSec: number;
  /**
   * JWT `typ` header. Defaults to `JWT` (ID tokens keep the OIDC default). Access tokens pass
   * `at+jwt` (RFC 9068 §2.1) so `/userinfo` and `/introspect` can reject an ID token presented as
   * an access token (token confusion) — same signer, same `aud`-less distinction otherwise.
   */
  typ?: string;
}

/** Signs JWTs with the active key: RS256, header `kid`, `iss` = configured issuer (INV-9). */
@Injectable()
export class TokenSigner {
  private readonly issuer: string;

  constructor(
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    config: ConfigService,
  ) {
    this.issuer = config.getOrThrow<AppConfig>('app').issuer;
  }

  async sign(claims: JWTPayload, options: SignOptions): Promise<string> {
    // Same claims, order and values as the former jose `SignJWT` chain (golden test in keys.spec).
    const iat = Math.floor(Date.now() / 1000);
    const payload: JWTPayload = {
      ...claims,
      iss: this.issuer,
      aud: options.audience,
      iat,
      exp: iat + options.expiresInSec,
      jti: randomUUID(),
      ...(options.subject ? { sub: options.subject } : {}),
    };
    return this.keys.signJwt({ typ: options.typ ?? 'JWT' }, payload);
  }
}
