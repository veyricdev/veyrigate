import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FederationConfig } from '../../config/configuration';
import { AuthenticationModule } from '../authentication/authentication.module';
import { IdentityModule } from '../identity/identity.module';
import { OauthModule } from '../oauth/oauth.module';
import { CsrfGuard, CsrfService } from '../ui/csrf.service';
import { HtmlExceptionFilter } from '../ui/html-exception.filter';
import { FederationController } from './federation.controller';
import { FederationService } from './federation.service';
import { FederationStateStore } from './federation-state.store';
import { buildFederationProviders, FEDERATION_PROVIDERS } from './providers';

/**
 * Identity broker for Google/GitHub (B5.1/B5.2, spec §9.9). The provider registry is static code
 * exposed through `FEDERATION_PROVIDERS` (exported so the login page can show only enabled
 * buttons). `HtmlExceptionFilter`, `CsrfService` and `CsrfGuard` (the `/auth/link` form, B5.3) are
 * provided locally (like OauthModule): no `UiModule` import, so `UiModule -> FederationModule` has
 * no cycle.
 */
@Module({
  imports: [IdentityModule, OauthModule, AuthenticationModule],
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
    CsrfService,
    CsrfGuard,
    HtmlExceptionFilter,
  ],
  exports: [FEDERATION_PROVIDERS],
})
export class FederationModule {}
