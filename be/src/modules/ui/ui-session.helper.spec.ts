import { describe, expect, it } from '@jest/globals';
import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { HttpReply, HttpRequest } from '../../common/http/http.types';
import type { RateLimitService } from '../security/rate-limit/rate-limit.service';
import { SessionCookie } from '../sessions/session.cookie';
import type { Session, SessionService } from '../sessions/session.service';
import { AuthenticationService } from '../authentication/authentication.service';
import type { AuthorizeRequestContextService } from '../oauth/authorize/authorize-request-context.service';
import { AuditAction } from '../security/audit/audit-action.enum';
import type { AuditService } from '../security/audit/audit.service';
import { UiSessionHelper } from './ui-session.helper';

/** Run 89 T0 (DEBT-632): the shared session helper of the HTML controllers. */
describe('UiSessionHelper', () => {
  const config = {
    getOrThrow: (ns: string) =>
      ns === 'session' ? { cookieSecure: false } : { sessionAbsoluteTtl: 86400 },
  } as unknown as ConfigService;
  const cookie = new SessionCookie(config);
  const make = (
    get: (id: string) => Promise<Session | null>,
    hit: RateLimitService['hit'] = async () => ({ allowed: true, retryAfterSec: 0, exceeded: [] }),
    auth: Partial<Record<'hasPassword' | 'verifyCurrentPassword', unknown>> = {},
    records: unknown[] = [],
  ) =>
    new UiSessionHelper(
      { get } as unknown as SessionService,
      cookie,
      { hit } as unknown as RateLimitService,
      config,
      auth as unknown as AuthenticationService,
      { record: async (e: unknown) => void records.push(e) } as unknown as AuditService,
      { peek: async () => null } as unknown as AuthorizeRequestContextService,
    );
  const reply = () => {
    const cleared: string[] = [];
    const set: string[] = [];
    const r = {
      clearCookie: (name: string) => cleared.push(name),
      setCookie: (name: string) => set.push(name),
    } as unknown as HttpReply;
    return { r, cleared, set };
  };

  it('a dead session cookie is cleared and dropped from the request', async () => {
    const helper = make(async () => null);
    const req = { cookies: { idp_session: 'dead' } } as unknown as HttpRequest;
    const { r, cleared } = reply();
    expect(await helper.liveSession(req, r)).toBeNull();
    expect(cleared).toEqual(['idp_session']);
    expect(req.cookies?.idp_session).toBeUndefined();
  });

  it('a live session is returned, nothing cleared; no cookie => null without a lookup', async () => {
    const live = { ref: 'r', userId: 'u' } as Session;
    let lookups = 0;
    const helper = make(async () => {
      lookups++;
      return live;
    });
    const { r, cleared } = reply();
    expect(
      await helper.liveSession({ cookies: { idp_session: 'x' } } as unknown as HttpRequest, r),
    ).toBe(live);
    expect(await helper.liveSession({ cookies: {} } as unknown as HttpRequest, r)).toBeNull();
    expect(lookups).toBe(1);
    expect(cleared).toEqual([]);
  });

  it('CSRF identity: the session cookie, else the anonymous cookie (minted when missing)', () => {
    const helper = make(async () => null);
    const { r, set } = reply();
    expect(helper.identity({ cookies: { idp_session: 'S' } } as unknown as HttpRequest, r)).toBe(
      'S',
    );
    expect(helper.identity({ cookies: { idp_csrf: 'A' } } as unknown as HttpRequest, r)).toBe('A');
    expect(set).toEqual([]);
    const minted = helper.identity({ cookies: {} } as unknown as HttpRequest, r);
    expect(minted).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(set).toEqual(['idp_csrf']);
  });

  it('limit: blocked => 429 with retryAfter; the subject carries ip, account and device', async () => {
    const seen: unknown[] = [];
    const helper = make(
      async () => null,
      async (rule, subject) => {
        seen.push({ rule, subject });
        return { allowed: false, retryAfterSec: 7, exceeded: ['ip'] };
      },
    );
    const req = { ip: '203.0.113.9', cookies: { idp_csrf: 'dev' } } as unknown as HttpRequest;
    const err = await helper.limit('account_mfa', req, 'user-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).getResponse()).toEqual({ retryAfter: 7 });
    expect(seen).toEqual([
      {
        rule: { name: 'account_mfa' },
        subject: { ip: '203.0.113.9', account: 'user-1', deviceId: 'dev' },
      },
    ]);
  });

  describe('reauth (D88.18, DEBT-638)', () => {
    const req = {
      ip: '203.0.113.7',
      id: 'req-9',
      headers: { 'user-agent': 'UA' },
    } as unknown as HttpRequest;
    const opts = {
      audit: {
        action: AuditAction.AUTH_REAUTH_FAILED,
        targetType: 'user',
        metadata: { scope: 'x' },
      },
      noPasswordMessage: 'NO-PW',
    };
    const session = (ageMs: number) => ({ userId: 'u1', authTime: Date.now() - ageMs }) as Session;
    const run = async (
      s: Session,
      password: string | undefined,
      auth: { hasPassword: boolean; verify?: unknown },
      always = false,
    ) => {
      const records: Record<string, unknown>[] = [];
      const helper = make(
        async () => null,
        undefined,
        {
          hasPassword: async () => auth.hasPassword,
          verifyCurrentPassword: async () => auth.verify,
        },
        records,
      );
      const out = await helper
        .reauth(req, s, password, { ...opts, alwaysPassword: always })
        .catch((e: unknown) => e);
      return { out, records };
    };

    it('fresh session => ok without a password; alwaysPassword => password still required', async () => {
      expect((await run(session(1000), undefined, { hasPassword: true })).out).toEqual({
        ok: true,
      });
      expect((await run(session(1000), undefined, { hasPassword: true }, true)).out).toMatchObject({
        ok: false,
        status: 400,
      });
    });

    it('no password: ok inside the window only (also with alwaysPassword)', async () => {
      expect((await run(session(1000), undefined, { hasPassword: false }, true)).out).toEqual({
        ok: true,
      });
      expect((await run(session(400_000), undefined, { hasPassword: false })).out).toEqual({
        ok: false,
        status: 400,
        error: 'NO-PW',
      });
    });

    it('wrong password => 400 + one reauth_failed audit carrying ip, userAgent, requestId', async () => {
      const { out, records } = await run(session(400_000), 'bad', {
        hasPassword: true,
        verify: { kind: 'invalid' },
      });
      expect(out).toMatchObject({ ok: false, status: 400 });
      expect(records).toEqual([
        expect.objectContaining({
          action: AuditAction.AUTH_REAUTH_FAILED,
          result: 'failure',
          reason: 'reauth_failed',
          ip: '203.0.113.7',
          userAgent: 'UA',
          requestId: 'req-9',
          metadata: { scope: 'x' },
        }),
      ]);
    });

    it('throttled => 429; audited only when reported', async () => {
      const first = await run(session(400_000), 'x', {
        hasPassword: true,
        verify: { kind: 'throttled', retryAfterSec: 5, report: true },
      });
      expect((first.out as HttpException).getStatus()).toBe(429);
      expect(first.records).toHaveLength(1);
      const again = await run(session(400_000), 'x', {
        hasPassword: true,
        verify: { kind: 'throttled', retryAfterSec: 5, report: false },
      });
      expect((again.out as HttpException).getStatus()).toBe(429);
      expect(again.records).toHaveLength(0);
    });
  });
});
