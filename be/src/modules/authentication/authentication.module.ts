import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { OauthModule } from '../oauth/oauth.module';
import { AuthenticationService } from './authentication.service';
import { LoginThrottleService } from './login-throttle.service';

@Module({
  imports: [IdentityModule, OauthModule],
  providers: [AuthenticationService, LoginThrottleService],
  exports: [AuthenticationService, LoginThrottleService],
})
export class AuthenticationModule {}
