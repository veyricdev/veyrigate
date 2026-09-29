import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignJWT, type JWTPayload } from 'jose';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config/configuration';
import { KEY_PROVIDER, type KeyProvider } from './key-provider';

export interface SignOptions {
  audience: string;
  subject?: string;
  expiresInSec: number;
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
    const { kid, privateKey } = await this.keys.getSigningKey();
    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
      .setIssuer(this.issuer)
      .setAudience(options.audience)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + options.expiresInSec)
      .setJti(randomUUID());
    if (options.subject) {
      jwt.setSubject(options.subject);
    }
    return jwt.sign(privateKey);
  }
}
