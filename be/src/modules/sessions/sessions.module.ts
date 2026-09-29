import { Module } from '@nestjs/common';
import { SessionCookie } from './session.cookie';
import { SessionService } from './session.service';

/** Redis-backed sessions + the `idp_session` cookie (B2.3). */
@Module({
  providers: [SessionService, SessionCookie],
  exports: [SessionService, SessionCookie],
})
export class SessionsModule {}
