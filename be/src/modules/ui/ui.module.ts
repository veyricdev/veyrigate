import { Module } from '@nestjs/common';
import { AuthenticationModule } from '../authentication/authentication.module';
import { FederationModule } from '../federation/federation.module';
import { IdentityModule } from '../identity/identity.module';
import { OauthModule } from '../oauth/oauth.module';
import { CsrfGuard, CsrfService } from './csrf.service';
import { HtmlExceptionFilter } from './html-exception.filter';
import { UiController } from './ui.controller';

@Module({
  // OauthModule pulls `CsrfService`/`HtmlExceptionFilter` from `ui` as plain providers (not
  // UiModule) and does not import UiModule back, so there is no cycle — a direct import is enough.
  // FederationModule exports the static provider registry (login page buttons, B5.2).
  imports: [AuthenticationModule, IdentityModule, OauthModule, FederationModule],
  controllers: [UiController],
  providers: [CsrfService, CsrfGuard, HtmlExceptionFilter],
})
export class UiModule {}
