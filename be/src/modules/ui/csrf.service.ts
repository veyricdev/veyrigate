import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { constantTimeEqual, generateToken } from '../../common/crypto/crypto.util';
import type { HttpReply, HttpRequest } from '../../common/http/http.types';
import type { SecurityConfig } from '../../config/configuration';
import { hostCookieName, SessionCookie } from '../sessions/session.cookie';

export const ANON_COOKIE = 'idp_csrf';
/** Name of the anonymous CSRF cookie: `__Host-idp_csrf` when Secure (DEBT-008), else `idp_csrf`. */
export const csrfCookieName = (secure: boolean): string => hostCookieName(ANON_COOKIE, secure);

/**
 * CSRF identity of an HTML form page (shared by `/login`-style pages and `/auth/link`): the session
 * cookie when present, else the anonymous CSRF cookie (`csrfCookieName`), minted on `reply` when missing.
 * `CsrfGuard` verifies the posted token against the same identity.
 */
export function formCsrfIdentity(
  session: string | undefined,
  req: HttpRequest,
  reply: HttpReply,
  secure: boolean,
): string {
  if (session) return session;
  const name = csrfCookieName(secure);
  let anon = req.cookies?.[name];
  if (!anon) {
    anon = generateToken();
    reply.setCookie(name, anon, { httpOnly: true, sameSite: 'lax', secure, path: '/' });
  }
  return anon;
}

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
    const identity =
      this.sessionCookie.read(request) ||
      request.cookies?.[csrfCookieName(this.sessionCookie.secure)];
    if (!identity || typeof body?._csrf !== 'string' || !this.csrf.verify(identity, body._csrf)) {
      throw new ForbiddenException('Invalid form submission.');
    }
    return true;
  }
}
