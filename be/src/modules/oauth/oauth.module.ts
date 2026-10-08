import { Module } from '@nestjs/common';
import { ClientsModule } from '../clients/clients.module';
import { ResourcesModule } from '../resources/resources.module';
import { SessionsModule } from '../sessions/sessions.module';
import { AuthorizeController } from './authorize/authorize.controller';
import { AuthorizeRequestContextService } from './authorize/authorize-request-context.service';
import { AuthorizeService } from './authorize/authorize.service';
import { AuthorizationCodeService } from './code/authorization-code.service';
import { HtmlExceptionFilter } from '../ui/html-exception.filter';

/**
 * OAuth core (B4). B4.1: `/authorize` + AuthorizeRequestContext. B4.3: AuthorizationCode store
 * (store + Lua primitive only — not wired into `/authorize` yet, that's B4.2/consent; `/token`
 * is B4.4).
 * `HtmlExceptionFilter` is provided locally (used via `@UseFilters` on the controller for the
 * open-redirect error page); the shared helpers from `ui` (`safeReturnTo`) are plain functions,
 * so no `UiModule` DI import is needed.
 */
@Module({
  imports: [ClientsModule, ResourcesModule, SessionsModule],
  controllers: [AuthorizeController],
  providers: [
    AuthorizeService,
    AuthorizeRequestContextService,
    AuthorizationCodeService,
    HtmlExceptionFilter,
  ],
  exports: [AuthorizeRequestContextService, AuthorizationCodeService],
})
export class OauthModule {}
