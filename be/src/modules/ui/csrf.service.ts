import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { constantTimeEqual } from '../../common/crypto/crypto.util';
import type { SecurityConfig } from '../../config/configuration';
import { SessionCookie } from '../sessions/session.cookie';

const ANON_COOKIE = 'idp_csrf';

interface CsrfRequest {
  body?: { _csrf?: unknown };
  cookies?: Record<string, string>;
}

@Injectable()
export class CsrfService {
  private readonly secret: string;
  constructor(config: ConfigService) {
    this.secret = config.getOrThrow<SecurityConfig>('security').csrfSecret;
  }
  token(identity: string): string {
    return createHmac('sha256', this.secret).update(identity).digest('base64url');
  }
  verify(identity: string, token: string): boolean {
    return constantTimeEqual(this.token(identity), token);
  }
}

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly csrf: CsrfService,
    private readonly sessionCookie: SessionCookie,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<CsrfRequest>();
    const body = request.body;
    const identity = this.sessionCookie.read(request) || request.cookies?.[ANON_COOKIE];
    if (!identity || typeof body?._csrf !== 'string' || !this.csrf.verify(identity, body._csrf)) {
      throw new ForbiddenException('Invalid form submission.');
    }
    return true;
  }
}
