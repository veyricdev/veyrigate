import { describe, expect, it, jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import { sha256 } from '../../common/crypto/crypto.util';
import type { RedisService } from '../../database/redis/redis.service';
import type { LoginThrottleService } from '../authentication/login-throttle.service';
import type { UserService } from '../identity/user.service';
import { AuditAction } from '../security/audit/audit-action.enum';
import type { AuditService } from '../security/audit/audit.service';
import type { RateLimitService } from '../security/rate-limit/rate-limit.service';
import type { SessionService } from '../sessions/session.service';
import { MfaLoginService } from './mfa-login.service';
import type { MfaService } from './mfa.service';

/**
 * Run 89 DEBT-641: the fail-closed branches of step 2 AFTER `establish` (Redis/Mongo stubbed): a
 * re-check DB error and an enrollment changed between verify and `establish` both kill the new
 * session; neither ever reports success.
 */
const ENROLLED = new Date(1_800_000_000_000);
const PASSWORD_HASH = '$argon2id$stub';

function harness(opts: { recheck: 'throws' | Date | null }) {
  const ticket: Record<string, string> = {
    userId: '65f0000000000000000000aa',
    returnTo: '/account/sessions',
    amr: JSON.stringify(['pwd']),
    enrolledAt: String(ENROLLED.getTime()),
    pwdFp: sha256(PASSWORD_HASH),
    trustDevice: '0',
    fails: '0',
  };
  const client = {
    defineCommand: () => undefined,
    hgetall: jest.fn(async () => ticket),
    del: jest.fn(async () => 1),
    set: jest.fn(async () => 'OK'),
  };
  const sessions = {
    establish: jest.fn(async () => ({ id: 'new-session', session: { ref: 'ref-1' } })),
    revoke: jest.fn(async (_id: string) => undefined),
  };
  const users = {
    findByIdForAuthentication: jest.fn(async () => {
      if (opts.recheck === 'throws') throw new Error('mongo down');
      return { sub: ticket.userId, passwordHash: PASSWORD_HASH };
    }),
    mfaEnrolledAt: jest.fn(async () => (opts.recheck === 'throws' ? null : opts.recheck)),
  };
  const records: { action: AuditAction; result: string }[] = [];
  const throttle = { onSuccess: jest.fn(async () => undefined) };
  const svc = new MfaLoginService(
    { client } as unknown as RedisService,
    {
      verify: async () => ({ ok: true, enrolledAt: ENROLLED, step: 1 }),
      clock: () => Date.now(),
    } as unknown as MfaService,
    sessions as unknown as SessionService,
    users as unknown as UserService,
    { record: async (e: never) => void records.push(e) } as unknown as AuditService,
    throttle as unknown as LoginThrottleService,
    {
      reserve: async () => ({ blocked: false, retryAfterSec: 0 }),
      refund: async () => undefined,
    } as unknown as RateLimitService,
    {
      getOrThrow: () => ({ cookieSecure: false, issuer: 'http://localhost:4000' }),
    } as unknown as ConfigService,
    { send: async () => undefined } as never,
  );
  return { svc, sessions, records, throttle };
}

describe('MfaLoginService.complete after establish (DEBT-641)', () => {
  const T = 'A'.repeat(43);

  it('control: same enrollment, fresh user => signed in, success audit', async () => {
    const h = harness({ recheck: ENROLLED });
    expect(await h.svc.complete(T, '123456', {})).toMatchObject({ kind: 'signed_in' });
    expect(h.sessions.revoke).not.toHaveBeenCalled();
    expect(h.records.map((r) => r.action)).toContain(AuditAction.AUTH_LOGIN_SUCCESS);
  });

  it('(a) the re-check read fails => the new session is revoked and the error propagates (5xx)', async () => {
    const h = harness({ recheck: 'throws' });
    await expect(h.svc.complete(T, '123456', {})).rejects.toThrow('mongo down');
    expect(h.sessions.revoke).toHaveBeenCalledWith('new-session');
    expect(h.records.map((r) => r.action)).not.toContain(AuditAction.AUTH_LOGIN_SUCCESS);
    expect(h.throttle.onSuccess).not.toHaveBeenCalled();
  });

  it.each([
    ['reset (no enrollment any more)', null],
    ['reset + enrolled again (another enrolledAt)', new Date(ENROLLED.getTime() + 1)],
  ])(
    '(c) %s between verify and establish => session revoked, failed, no success',
    async (_n, now) => {
      const h = harness({ recheck: now });
      expect(await h.svc.complete(T, '123456', {})).toEqual({ kind: 'failed' });
      expect(h.sessions.revoke).toHaveBeenCalledWith('new-session');
      const actions = h.records.map((r) => r.action);
      expect(actions).toContain(AuditAction.AUTH_LOGIN_FAILED);
      expect(actions).not.toContain(AuditAction.AUTH_LOGIN_SUCCESS);
      expect(h.throttle.onSuccess).not.toHaveBeenCalled();
    },
  );
});
