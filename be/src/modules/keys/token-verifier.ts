import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createLocalJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { AppConfig } from '../../config/configuration';
import { KEY_PROVIDER, type KeyProvider } from './key-provider';

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
}
