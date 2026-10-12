import { Module, forwardRef } from '@nestjs/common';
import { AuthenticationModule } from '../authentication/authentication.module';
import { IdentityModule } from '../identity/identity.module';
import { OauthModule } from '../oauth/oauth.module';
import { CsrfGuard, CsrfService } from './csrf.service';
import { HtmlExceptionFilter } from './html-exception.filter';
import { UiController } from './ui.controller';

@Module({
  // `forwardRef` to OauthModule: Oauth pulls `CsrfService`/`HtmlExceptionFilter` from `ui` as plain
  // providers (not UiModule), but the lazy ref keeps NestJS happy if that wiring ever changes.
  imports: [AuthenticationModule, IdentityModule, forwardRef(() => OauthModule)],
  controllers: [UiController],
  providers: [CsrfService, CsrfGuard, HtmlExceptionFilter],
})
export class UiModule {}
