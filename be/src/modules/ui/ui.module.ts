import { Module } from '@nestjs/common';
import { AuthenticationModule } from '../authentication/authentication.module';
import { IdentityModule } from '../identity/identity.module';
import { CsrfGuard, CsrfService } from './csrf.service';
import { HtmlExceptionFilter } from './html-exception.filter';
import { UiController } from './ui.controller';

@Module({
  imports: [AuthenticationModule, IdentityModule],
  controllers: [UiController],
  providers: [CsrfService, CsrfGuard, HtmlExceptionFilter],
})
export class UiModule {}
