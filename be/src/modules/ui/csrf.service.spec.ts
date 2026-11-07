import { describe, expect, it } from '@jest/globals';
import type { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { HttpReply, HttpRequest } from '../../common/http/http.types';
import { SessionCookie } from '../sessions/session.cookie';
import { CsrfGuard, CsrfService, csrfCookieName, formCsrfIdentity } from './csrf.service';

describe('CsrfService', () => {
  const service = new CsrfService({
    getOrThrow: () => ({ csrfSecret: 'a'.repeat(32) }),
  } as unknown as ConfigService);

  it('binds a token to its session or anonymous cookie identity', () => {
    const token = service.token('identity-a');
    expect(service.verify('identity-a', token)).toBe(true);
    expect(service.verify('identity-b', token)).toBe(false);
    expect(service.verify('identity-a', `${token}x`)).toBe(false);
  });
});

describe('anonymous CSRF cookie name (DEBT-008)', () => {
  const sessionCookie = (cookieSecure: boolean) =>
    new SessionCookie({
      getOrThrow: (ns: string) =>
        ns === 'session' ? { cookieSecure } : { sessionAbsoluteTtl: 86400 },
    } as unknown as ConfigService);
  const csrf = new CsrfService({
    getOrThrow: () => ({ csrfSecret: 'a'.repeat(32) }),
  } as unknown as ConfigService);
  const replyRecorder = () => {
    const set: { name: string; options: Record<string, unknown> }[] = [];
    const reply = {
      setCookie: (name: string, _value: string, options: Record<string, unknown>) =>
        set.push({ name, options }),
    } as unknown as HttpReply;
    return { reply, set };
  };
  const guard = (secure: boolean, cookies: Record<string, string>, token: string) =>
    new CsrfGuard(csrf, sessionCookie(secure)).canActivate({
      switchToHttp: () => ({ getRequest: () => ({ cookies, body: { _csrf: token } }) }),
    } as unknown as ExecutionContext);

  it('is __Host-idp_csrf when Secure, idp_csrf otherwise', () => {
    expect(csrfCookieName(true)).toBe('__Host-idp_csrf');
    expect(csrfCookieName(false)).toBe('idp_csrf');
  });

  it('Secure: mints __Host-idp_csrf host-only (Path=/, Secure, no Domain)', () => {
    const { reply, set } = replyRecorder();
    formCsrfIdentity(undefined, { cookies: {} } as unknown as HttpRequest, reply, true);
    expect(set).toHaveLength(1);
    expect(set[0].name).toBe('__Host-idp_csrf');
    expect(set[0].options).toMatchObject({ path: '/', secure: true, httpOnly: true });
    expect(set[0].options).not.toHaveProperty('domain');
  });

  it('Secure: a legacy idp_csrf is ignored (fresh __Host- identity minted, never reused)', () => {
    const { reply, set } = replyRecorder();
    const req = { cookies: { idp_csrf: 'tossed-anon' } } as unknown as HttpRequest;
    const identity = formCsrfIdentity(undefined, req, reply, true);
    expect(identity).not.toBe('tossed-anon');
    expect(set.map((c) => c.name)).toEqual(['__Host-idp_csrf']);
  });

  it('Secure: reuses an existing __Host-idp_csrf', () => {
    const { reply, set } = replyRecorder();
    const req = { cookies: { '__Host-idp_csrf': 'anon-1' } } as unknown as HttpRequest;
    expect(formCsrfIdentity(undefined, req, reply, true)).toBe('anon-1');
    expect(set).toHaveLength(0);
  });

  it('non-Secure: keeps the legacy idp_csrf name', () => {
    const { reply, set } = replyRecorder();
    formCsrfIdentity(undefined, { cookies: {} } as unknown as HttpRequest, reply, false);
    expect(set[0].name).toBe('idp_csrf');
    expect(set[0].options).toMatchObject({ path: '/', secure: false });
  });

  it('guard (Secure) accepts the __Host- identity, rejects the same token under the legacy name', () => {
    const token = csrf.token('anon-1');
    expect(guard(true, { '__Host-idp_csrf': 'anon-1' }, token)).toBe(true);
    expect(() => guard(true, { idp_csrf: 'anon-1' }, token)).toThrow('Invalid form submission.');
    // legacy session cookie is not an identity either
    expect(() => guard(true, { idp_session: 'anon-1' }, token)).toThrow('Invalid form submission.');
  });

  it('guard (non-Secure) uses the legacy names', () => {
    const token = csrf.token('anon-1');
    expect(guard(false, { idp_csrf: 'anon-1' }, token)).toBe(true);
    expect(() => guard(false, { '__Host-idp_csrf': 'anon-1' }, token)).toThrow();
  });
});
