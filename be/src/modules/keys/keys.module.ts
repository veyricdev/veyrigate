import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientsModule } from '../clients/clients.module';
import type { AppConfig, KeysConfig, TokenConfig } from '../../config/configuration';
import { KEY_PROVIDER, type KeyProvider } from './key-provider';
import { KeyRotationService } from './key-rotation.service';
import { KeysController } from './keys.controller';
import { LocalKeyProvider } from './local-key-provider';
import { TokenSigner } from './token-signer';
import { TokenVerifier } from './token-verifier';
import { VaultTransitKeyProvider } from './vault-transit-key-provider';

/** Key management (B1.9): KeyProvider, JWKS, token sign/verify, rotation. */
@Module({
  imports: [ClientsModule],
  controllers: [KeysController],
  providers: [
    {
      provide: KEY_PROVIDER,
      inject: [ConfigService],
      useFactory: async (config: ConfigService): Promise<KeyProvider> => {
        const { provider, localDir, vault } = config.getOrThrow<KeysConfig>('keys');
        const { nodeEnv } = config.getOrThrow<AppConfig>('app');
        if (provider === 'vault') {
          // Boot check against Vault (run 53): any misconfiguration ⇒ the app does not start.
          const transit = new VaultTransitKeyProvider(
            vault!,
            config.getOrThrow<TokenConfig>('token').accessTokenTtl,
          );
          await transit.init();
          return transit;
        }
        // Defence in depth: env validation already rejects local in production.
        if (nodeEnv === 'production') {
          throw new Error(
            'LocalKeyProvider is dev-only; configure a KMS/Vault provider (plan B7.3)',
          );
        }
        const local = new LocalKeyProvider(localDir!);
        await local.init();
        return local;
      },
    },
    TokenSigner,
    TokenVerifier,
    KeyRotationService,
  ],
  exports: [TokenSigner, TokenVerifier, KeyRotationService],
})
export class KeysModule {}
