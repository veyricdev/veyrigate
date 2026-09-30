import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { AuthenticationService } from './authentication.service';

@Module({
  imports: [IdentityModule],
  providers: [AuthenticationService],
  exports: [AuthenticationService],
})
export class AuthenticationModule {}
