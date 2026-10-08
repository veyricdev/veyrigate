import { Module } from '@nestjs/common';
import { ClientsModule } from '../clients/clients.module';
import { KeysModule } from '../keys/keys.module';
import { ResourcesModule } from '../resources/resources.module';
import { SessionsModule } from '../sessions/sessions.module';
import { AuthorizeController } from './authorize/authorize.controller';
import { AuthorizeRequestContextService } from './authorize/authorize-request-context.service';
import { AuthorizeService } from './authorize/authorize.service';
import { AuthorizationCodeService } from './code/authorization-code.service';
import { ConsentService } from './consent/consent.service';
import { TokenController } from './token/token.controller';
import { TokenService } from './token/token.service';
import { HtmlExceptionFilter } from '../ui/html-exception.filter';
import { CsrfGuard, CsrfService } from '../ui/csrf.service';

/**
 * OAuth core (B4). B4.1: `/authorize` + AuthorizeRequestContext. B4.3: AuthorizationCode store
 * (store + Lua primitive only — not wired into `/authorize` yet, that's B4.2/consent; `/token`
 * is B4.4).
 * `HtmlExceptionFilter` is provided locally (used via `@UseFilters` on the controller for the
 * open-redirect error page); the shared helpers from `ui` (`safeReturnTo`) are plain functions,
 * so no `UiModule` DI import is needed.
 */
@Module({
  imports: [ClientsModule, ResourcesModule, SessionsModule, KeysModule],
  controllers: [AuthorizeController, TokenController],
  providers: [
    AuthorizeService,
    AuthorizeRequestContextService,
    AuthorizationCodeService,
    ConsentService,
    TokenService,
    CsrfService,
    CsrfGuard,
    HtmlExceptionFilter,
  ],
  exports: [AuthorizeRequestContextService, AuthorizationCodeService, ConsentService],
})
export class OauthModule {}
