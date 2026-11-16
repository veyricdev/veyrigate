import { Module } from '@nestjs/common';
import { AuthenticationModule } from '../authentication/authentication.module';
import { ClientsModule } from '../clients/clients.module';
import { FederationModule } from '../federation/federation.module';
import { IdentityModule } from '../identity/identity.module';
import { MfaModule } from '../mfa/mfa.module';
import { OauthModule } from '../oauth/oauth.module';
import { CsrfGuard, CsrfService } from './csrf.service';
import { HtmlExceptionFilter } from './html-exception.filter';
import { AccountController } from './account.controller';
import { MfaController } from './mfa.controller';
import { UiController } from './ui.controller';
import { UiSessionHelper } from './ui-session.helper';

@Module({
  // OauthModule pulls `CsrfService`/`HtmlExceptionFilter` from `ui` as plain providers (not
  // UiModule) and does not import UiModule back, so there is no cycle — a direct import is enough.
  // FederationModule exports the static provider registry (login page buttons, B5.2).
  imports: [
    AuthenticationModule,
    ClientsModule,
    IdentityModule,
    OauthModule,
    FederationModule,
    MfaModule,
  ],
  controllers: [UiController, AccountController, MfaController],
  providers: [CsrfService, CsrfGuard, HtmlExceptionFilter, UiSessionHelper],
})
export class UiModule {}
