import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FederationConfig } from '../../config/configuration';
import { IdentityModule } from '../identity/identity.module';
import { OauthModule } from '../oauth/oauth.module';
import { HtmlExceptionFilter } from '../ui/html-exception.filter';
import { FederationController } from './federation.controller';
import { FederationService } from './federation.service';
import { FederationStateStore } from './federation-state.store';
import { buildFederationProviders, FEDERATION_PROVIDERS } from './providers';

/**
 * Identity broker for Google/GitHub (B5.1/B5.2, spec §9.9). The provider registry is static code
 * exposed through `FEDERATION_PROVIDERS` (exported so the login page can show only enabled
 * buttons). `HtmlExceptionFilter` is provided locally (like OauthModule): no `UiModule` import, so
 * `UiModule -> FederationModule` has no cycle.
 */
@Module({
  imports: [IdentityModule, OauthModule],
  controllers: [FederationController],
  providers: [
    {
      provide: FEDERATION_PROVIDERS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        buildFederationProviders(config.getOrThrow<FederationConfig>('federation')),
    },
    FederationService,
    FederationStateStore,
    HtmlExceptionFilter,
  ],
  exports: [FEDERATION_PROVIDERS],
})
export class FederationModule {}
