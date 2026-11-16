import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MfaConfig } from '../../config/configuration';
import { AuthenticationModule } from '../authentication/authentication.module';
import { IdentityModule } from '../identity/identity.module';
import { MFA_KEYRING, MfaKeyring } from './mfa-crypto';
import { MfaLoginService } from './mfa-login.service';
import { MfaService } from './mfa.service';

/**
 * Second factor (run 89, D89.2): pure TOTP / base32 / keyring / recovery codes, and `MfaService`
 * (state in Mongo), `MfaLoginService` (ticket + step 2 shared by every sign-in path). The keyring is
 * built once from the validated `MFA_ENCRYPTION_KEYS`.
 */
@Module({
  imports: [IdentityModule, AuthenticationModule],
  providers: [
    {
      provide: MFA_KEYRING,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new MfaKeyring(config.getOrThrow<MfaConfig>('mfa').keys),
    },
    MfaService,
    MfaLoginService,
  ],
  exports: [MFA_KEYRING, MfaService, MfaLoginService],
})
export class MfaModule {}
