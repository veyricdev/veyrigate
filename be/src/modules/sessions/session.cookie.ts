import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { SessionConfig, TokenConfig } from '../../config/configuration';

export const SESSION_COOKIE = 'idp_session';

/**
 * DEBT-008: a Secure cookie of the IdP host carries the `__Host-` prefix (browser-enforced
 * host-only + `Path=/` + `Secure`), so a sibling subdomain cannot toss it. The plain name is only
 * for the http dev/E2E mode (`SESSION_COOKIE_SECURE=false`). Hard cut: only this mode's name is
 * ever read (no fallback to the other one).
 */
export const hostCookieName = (base: string, secure: boolean): string =>
  secure ? `__Host-${base}` : base;

/** Structural Fastify shapes (fastify is only a transitive dependency). */
interface CookieRequest {
  cookies?: Record<string, string | undefined>;
}
interface CookieReply {
  setCookie(name: string, value: string, options: CookieSerializeOptions): unknown;
  clearCookie(name: string, options: CookieSerializeOptions): unknown;
}

/**
 * The only place that reads/writes the session cookie (B2.3, INV-16): `__Host-idp_session` when
 * Secure, `idp_session` in http dev (DEBT-008).
 * `HttpOnly; Secure; SameSite=Lax; Path=/`, host-only (never `Domain`), unsigned
 * (the value is a 256-bit random ID — signing adds nothing). The value carries
 * no user data.
 */
@Injectable()
export class SessionCookie {
  private readonly options: CookieSerializeOptions;
  readonly secure: boolean;
  readonly name: string;

  constructor(config: ConfigService) {
    const { cookieSecure } = config.getOrThrow<SessionConfig>('session');
    this.secure = cookieSecure;
    this.name = hostCookieName(SESSION_COOKIE, cookieSecure);
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
    return req.cookies?.[this.name] || undefined;
  }

  set(reply: CookieReply, id: string): void {
    reply.setCookie(this.name, id, this.options);
  }

  clear(reply: CookieReply): void {
    // @fastify/cookie forces Max-Age=0 / Expires=epoch; other attributes must match `set`.
    reply.clearCookie(this.name, this.options);
  }
}
