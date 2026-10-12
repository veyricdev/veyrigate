import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { OauthModule } from '../oauth/oauth.module';
import { AuthenticationService } from './authentication.service';

@Module({
  imports: [IdentityModule, OauthModule],
  providers: [AuthenticationService],
  exports: [AuthenticationService],
})
export class AuthenticationModule {}
