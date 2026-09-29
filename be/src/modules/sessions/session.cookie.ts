import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { SessionConfig, TokenConfig } from '../../config/configuration';

export const SESSION_COOKIE = 'idp_session';

/** Structural Fastify shapes (fastify is only a transitive dependency). */
interface CookieRequest {
  cookies?: Record<string, string | undefined>;
}
interface CookieReply {
  setCookie(name: string, value: string, options: CookieSerializeOptions): unknown;
  clearCookie(name: string, options: CookieSerializeOptions): unknown;
}

/**
 * The only place that reads/writes the `idp_session` cookie (B2.3, INV-16).
 * `HttpOnly; Secure; SameSite=Lax; Path=/`, host-only (no `Domain`), unsigned
 * (the value is a 256-bit random ID — signing adds nothing). The value carries
 * no user data.
 */
@Injectable()
export class SessionCookie {
  private readonly options: CookieSerializeOptions;

  constructor(config: ConfigService) {
    const { cookieSecure } = config.getOrThrow<SessionConfig>('session');
    const { sessionAbsoluteTtl } = config.getOrThrow<TokenConfig>('token');
    this.options = {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: sessionAbsoluteTtl,
    };
  }

  read(req: CookieRequest): string | undefined {
    return req.cookies?.[SESSION_COOKIE] || undefined;
  }

  set(reply: CookieReply, id: string): void {
    reply.setCookie(SESSION_COOKIE, id, this.options);
  }

  clear(reply: CookieReply): void {
    // @fastify/cookie forces Max-Age=0 / Expires=epoch; other attributes must match `set`.
    reply.clearCookie(SESSION_COOKIE, this.options);
  }
}
