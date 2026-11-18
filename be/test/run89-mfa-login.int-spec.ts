import { jest } from '@jest/globals';
import { randomBytes, randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { hashPassword, sha256 } from '../src/common/crypto/crypto.util';
import { RedisService } from '../src/database/redis/redis.service';
import { networkOf } from '../src/modules/authentication/login-throttle.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { ADMIN_LOCKED_UNTIL, UserService } from '../src/modules/identity/user.service';
import { MFA_KEYRING, type MfaKeyring } from '../src/modules/mfa/mfa-crypto';
import { MfaService } from '../src/modules/mfa/mfa.service';
import { totpAt, totpStep } from '../src/modules/mfa/totp';
import { AuditAction } from '../src/modules/security/audit/audit-action.enum';
import { deriveS256Challenge } from '../src/common/crypto/pkce.util';
import {
  bootFullApp,
  FLOW_API_AUD,
  FLOW_REDIRECT,
  seedFlowClient,
  type FullApp,
  type InjectResponse,
} from './full-app';
import { enrollForTest } from './helpers/mfa';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';

/**
 * Run 89 T3 AC1–AC7, AC14 on the REAL app: an enrolled user's `/login` stops at an MFA ticket (no
 * session, no throttle success, no success audit); `POST /login/mfa` finishes it once, with replay,
 * brute force, CSRF and "something changed between step 1 and step 2" all refused.
 */
const PASSWORD = 'r89l-Current#Pass-1';
const SECRET = Buffer.from('r89-mfa-login-seed!!', 'ascii');
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0';
const WRONG = 'That code is not valid. Try again.';

const setCookies = (res: InjectResponse): string[] =>
  ([] as string[]).concat((res.headers['set-cookie'] as string | string[] | undefined) ?? []);
const rawCookie = (res: InjectResponse, name: string) =>
  setCookies(res).find((c) => c.startsWith(`${name}=`));
const pairOf = (res: InjectResponse, name: string) => rawCookie(res, name)?.split(';')[0];
const csrfOf = (res: InjectResponse): string => res.body.match(/name="_csrf" value="([^"]+)"/)![1];
const code = (offset = 0) => totpAt(SECRET, totpStep(Date.now()) + offset);

describe('run 89 T3: MFA step 2 at /login (real app)', () => {
  let full: FullApp;
  let redis: RedisService['client'];
  let keyring: MfaKeyring;
  let setup: Promise<void> | undefined;
  beforeAll(
    () =>
      (setup = (async () => {
        full = await bootFullApp({ name: 'run89-mfa-login' });
        redis = full.app.get(RedisService).client;
        keyring = full.app.get<MfaKeyring>(MFA_KEYRING);
      })()),
    INT_SETUP_TIMEOUT_MS,
  );
  afterAll(async () => {
    await settled(setup);
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);
  afterEach(() => jest.restoreAllMocks());

  const newUser = async (enroll = true) => {
    const email = `r89l-${randomUUID()}@fixture.test`;
    const users = full.app.get(UserService);
    const u = await users.create({ email, password: PASSWORD });
    await users.verifyEmail(u.sub);
    await full.conn
      .model('UserTenant')
      .create({ userId: new Types.ObjectId(u.sub), tenantId: DEFAULT_TENANT_ID, status: 'active' });
    const enrolled = enroll ? await enrollForTest(full.conn, keyring, u.sub, SECRET) : undefined;
    return { email, sub: u.sub, codes: enrolled?.codes ?? [] };
  };
  const ip = () => `198.51.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

  /** Step 1: real `/login` form post. */
  const step1 = async (email: string, from = ip(), returnTo = '/account/sessions', extra = '') => {
    const page = (await full.app.inject({
      method: 'GET',
      url: '/login',
      remoteAddress: from,
      headers: { 'user-agent': UA },
    })) as InjectResponse;
    const res = (await full.app.inject({
      method: 'POST',
      url: '/login',
      remoteAddress: from,
      headers: {
        cookie: [pairOf(page, 'idp_csrf')!, extra].filter(Boolean).join('; '),
        'user-agent': UA,
      },
      payload: { _csrf: csrfOf(page), email, password: PASSWORD, returnTo },
    })) as InjectResponse;
    const ticket = pairOf(res, 'idp_mfa');
    return { res, ticket, from, id: ticket?.split('=')[1] };
  };
  /** Step 2: GET the form (CSRF bound to the ticket cookie), POST the code. */
  const step2 = async (
    s: { ticket?: string; from: string },
    value: string,
    opts: { csrf?: string; cookie?: string } = {},
  ) => {
    const jar = opts.cookie ?? s.ticket ?? '';
    const form = (await full.app.inject({
      method: 'GET',
      url: '/login/mfa',
      remoteAddress: s.from,
      headers: { cookie: s.ticket ?? '', 'user-agent': UA },
    })) as InjectResponse;
    return full.app.inject({
      method: 'POST',
      url: '/login/mfa',
      remoteAddress: s.from,
      headers: { cookie: jar, 'user-agent': UA },
      payload: {
        _csrf: opts.csrf ?? (form.statusCode === 200 ? csrfOf(form) : 'x'),
        code: value,
      },
    }) as Promise<InjectResponse>;
  };
  const audits = (action: AuditAction, who: string) =>
    full.conn
      .model('AuditLog')
      .find({ action, $or: [{ actorId: who }, { targetId: who }] })
      .lean<Array<Record<string, unknown>>>()
      .exec();
  const userSessions = (sub: string) => redis.scard(`user_sess:${sub}`);
  const networkKey = (email: string, from: string) =>
    `lt:{e:${sha256(email)}}:n:${sha256(networkOf(from))}`;
  const sessionOf = async (res: InjectResponse) => {
    const id = pairOf(res, 'idp_session')!.split('=')[1];
    return JSON.parse((await redis.get(`sess:${sha256(id)}`))!) as Record<string, unknown>;
  };

  it('AC14 not enrolled: /login signs in at once, no ticket (behaviour unchanged)', async () => {
    const u = await newUser(false);
    const s = await step1(u.email);
    expect(s.res.statusCode).toBe(303);
    expect(s.res.headers['location']).toBe('/account/sessions');
    expect(pairOf(s.res, 'idp_session')).toBeDefined();
    expect(s.ticket).toBeUndefined();
  });

  it('AC1 enrolled + right password => ticket cookie only (HttpOnly, Lax, Path=/, Max-Age 300), no session, no success, bucket kept, no device trust', async () => {
    const u = await newUser();
    const s = await step1(u.email);
    expect(s.res.statusCode).toBe(303);
    expect(s.res.headers['location']).toBe('/login/mfa');
    expect(pairOf(s.res, 'idp_session')).toBeUndefined();
    expect(pairOf(s.res, 'idp_dc')).toBeUndefined();
    const raw = rawCookie(s.res, 'idp_mfa')!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).toMatch(/Path=\//);
    expect(raw).toMatch(/Max-Age=300/);
    expect(await userSessions(u.sub)).toBe(0);
    expect(await redis.get(networkKey(u.email, s.from))).toBe('1');
    expect(await redis.ttl(`mfa_pend:${sha256(s.id!)}`)).toBeGreaterThan(290);
    expect(await audits(AuditAction.AUTH_LOGIN_SUCCESS, u.sub)).toHaveLength(0);
    const page = (await full.app.inject({
      method: 'GET',
      url: '/login/mfa',
      headers: { cookie: s.ticket! },
    })) as InjectResponse;
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.body).not.toContain(u.email);
  });

  it('AC2 right TOTP => session amr pwd+otp+mfa, authTime = mfaAt, stored returnTo, audits, bucket cleared, device trusted, ticket gone', async () => {
    const u = await newUser();
    const s = await step1(u.email);
    const res = await step2(s, code());
    expect(res.statusCode).toBe(303);
    expect(res.headers['location']).toBe('/account/sessions');
    const sess = await sessionOf(res);
    expect(sess).toMatchObject({ userId: u.sub, amr: ['pwd', 'otp', 'mfa'] });
    expect(sess.mfaAt).toBe(sess.authTime);
    expect(Math.abs((sess.mfaAt as number) - Date.now())).toBeLessThan(10_000);
    expect(pairOf(res, 'idp_dc')).toBeDefined();
    expect(rawCookie(res, 'idp_mfa')).toMatch(/idp_mfa=;/);
    expect(await redis.exists(`mfa_pend:${sha256(s.id!)}`)).toBe(0);
    expect(await redis.get(networkKey(u.email, s.from))).toBeNull();
    const success = await audits(AuditAction.AUTH_LOGIN_SUCCESS, u.sub);
    expect(success).toHaveLength(1);
    expect(success[0]).toMatchObject({ metadata: { mfa: 'totp' } });
    expect(await audits(AuditAction.SESSION_CREATED, u.sub)).toHaveLength(1);
    for (const e of await full.conn.model('AuditLog').find({ actorId: u.sub }).lean().exec()) {
      expect(JSON.stringify(e)).not.toContain(code());
    }
    // The ticket is single-use.
    const again = await full.app.inject({
      method: 'GET',
      url: '/login/mfa',
      headers: { cookie: s.ticket! },
    });
    expect(again.headers['location']).toBe('/login');
  });

  it('AC3 recovery code => amr pwd+mfa, MFA_RECOVERY_USED {left:9}; the same code again => refused', async () => {
    const u = await newUser();
    const res = await step2(await step1(u.email), u.codes[0].toLowerCase());
    expect(res.statusCode).toBe(303);
    expect(await sessionOf(res)).toMatchObject({ amr: ['pwd', 'mfa'] });
    const used = await audits(AuditAction.MFA_RECOVERY_USED, u.sub);
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({ metadata: { left: 9 } });
    expect(JSON.stringify(used[0])).not.toContain(u.codes[0]);
    const again = await step2(await step1(u.email), u.codes[0]);
    expect(again.statusCode).toBe(400);
    expect(again.body).toContain(WRONG);
  });

  it('AC4 wrong x4 => 400 same text; 5th => ticket dropped, back to /login; per-user 10/900 over many tickets => 429 before any code; audits once', async () => {
    const u = await newUser();
    const s = await step1(u.email, ip(), '/account/apps');
    for (let i = 0; i < 4; i++) {
      const r = await step2(s, '000000');
      expect(r.statusCode).toBe(400);
      expect(r.body).toContain(WRONG);
    }
    const fifth = await step2(s, '000000');
    expect(fifth.statusCode).toBe(303);
    expect(fifth.headers['location']).toBe('/login?returnTo=%2Faccount%2Fapps');
    expect(await redis.exists(`mfa_pend:${sha256(s.id!)}`)).toBe(0);
    expect(await audits(AuditAction.AUTH_MFA_FAILED, u.sub)).toHaveLength(1);

    const s2 = await step1(u.email);
    for (let i = 0; i < 5; i++) await step2(s2, 'AAAA-BBBB-CCCC-DDDD');
    const s3 = await step1(u.email);
    const blocked = await step2(s3, code());
    expect(blocked.statusCode).toBe(429);
    expect(await userSessions(u.sub)).toBe(0);
    expect(await step2(s3, code())).toMatchObject({ statusCode: 429 });
    expect(await audits(AuditAction.AUTH_MFA_THROTTLED, u.sub)).toHaveLength(1);
    expect(await audits(AuditAction.AUTH_MFA_FAILED, u.sub)).toHaveLength(1);
  });

  it('AC5 replay: a code used in tab 1 is refused in tab 2; two parallel right POSTs on one ticket => one session', async () => {
    const u = await newUser();
    const a = await step1(u.email);
    const b = await step1(u.email);
    const k = code();
    expect((await step2(a, k)).statusCode).toBe(303);
    const replay = await step2(b, k);
    expect(replay.statusCode).toBe(400);

    const u2 = await newUser();
    const t = await step1(u2.email);
    const form = (await full.app.inject({
      method: 'GET',
      url: '/login/mfa',
      headers: { cookie: t.ticket! },
    })) as InjectResponse;
    const post = () =>
      full.app.inject({
        method: 'POST',
        url: '/login/mfa',
        headers: { cookie: t.ticket! },
        payload: { _csrf: csrfOf(form), code: code() },
      }) as Promise<InjectResponse>;
    const both = await Promise.all([post(), post()]);
    expect(both.filter((r) => pairOf(r, 'idp_session'))).toHaveLength(1);
    expect(await userSessions(u2.sub)).toBe(1);
  });

  it.each([
    [
      'admin lock',
      async (sub: string) =>
        full.conn
          .collection('users')
          .updateOne(
            { _id: new Types.ObjectId(sub) },
            { $set: { lockedUntil: ADMIN_LOCKED_UNTIL } },
          ),
    ],
    [
      'password changed',
      async (sub: string) =>
        full.app.get(UserService).setPassword(sub, await hashPassword('r89l-Other#Pass-2')),
    ],
  ])(
    'AC6 %s between step 1 and step 2 => the new session is killed, 401, no success audit',
    async (_n, change) => {
      const u = await newUser();
      const s = await step1(u.email);
      await change(u.sub);
      const res = await step2(s, code());
      expect(res.statusCode).toBe(401);
      expect(pairOf(res, 'idp_session')).toBeUndefined();
      expect(await userSessions(u.sub)).toBe(0);
      expect(await audits(AuditAction.AUTH_LOGIN_SUCCESS, u.sub)).toHaveLength(0);
    },
  );

  it('AC6 MFA turned off / reset + re-enrolled between the steps => step 2 refused, no session', async () => {
    const u = await newUser();
    const s = await step1(u.email);
    const mfa = full.app.get(MfaService);
    const state = (await mfa.state(u.sub)) as { enrolledAt: Date };
    expect(await mfa.disable(u.sub, state.enrolledAt)).toBe(true);
    await enrollForTest(full.conn, keyring, u.sub, SECRET, {
      enrolledAt: new Date(Date.now() + 1),
    });
    const res = await step2(s, code());
    expect(res.statusCode).toBe(400);
    expect(await userSessions(u.sub)).toBe(0);
  });

  it('AC7 no / unknown / garbage ticket => 302 /login; CSRF missing or bound elsewhere => 403; another user session cookie is ignored', async () => {
    const u = await newUser();
    const none = await full.app.inject({
      method: 'POST',
      url: '/login/mfa',
      payload: { code: '1' },
    });
    expect(none.statusCode).toBe(303);
    expect(none.headers['location']).toBe('/login');
    const unknown = await full.app.inject({
      method: 'GET',
      url: '/login/mfa',
      headers: { cookie: `idp_mfa=${'A'.repeat(43)}` },
    });
    expect(unknown.headers['location']).toBe('/login');
    const s = await step1(u.email);
    expect((await step2(s, code(), { csrf: '' })).statusCode).toBe(403);
    const other = await step1((await newUser()).email);
    const otherForm = (await full.app.inject({
      method: 'GET',
      url: '/login/mfa',
      headers: { cookie: other.ticket! },
    })) as InjectResponse;
    expect((await step2(s, code(), { csrf: csrfOf(otherForm) })).statusCode).toBe(403);

    const v = await newUser(false);
    const victim = await step1(v.email);
    const res = await step2(s, code(), {
      cookie: `${s.ticket}; ${pairOf(victim.res, 'idp_session')}`,
    });
    expect(res.statusCode).toBe(303);
    expect((await sessionOf(res)).userId).toBe(u.sub);
  });

  it('failure: Mongo error at the code check => 5xx, ticket kept, a retry succeeds', async () => {
    const u = await newUser();
    const s = await step1(u.email);
    const mfa = full.app.get(MfaService);
    jest.spyOn(mfa, 'verify').mockRejectedValueOnce(new Error('mongo down'));
    const failed = await step2(s, code());
    expect(failed.statusCode).toBeGreaterThanOrEqual(500);
    expect(await redis.exists(`mfa_pend:${sha256(s.id!)}`)).toBe(1);
    expect(await userSessions(u.sub)).toBe(0);
    expect((await step2(s, code())).statusCode).toBe(303);
  });

  it('DEBT-647 (D89.30) /login/mfa relaxes form-action to the RP origin of a live /authorize context (GET and the 400 re-render); anything else stays self', async () => {
    const bff = await seedFlowClient(full);
    const authz = (await full.app.inject({
      method: 'GET',
      url: `/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: bff.clientId,
        redirect_uri: FLOW_REDIRECT,
        scope: 'openid api.read',
        resource: FLOW_API_AUD,
        state: 's',
        code_challenge: deriveS256Challenge(randomBytes(32).toString('base64url')),
        code_challenge_method: 'S256',
      }).toString()}`,
    })) as InjectResponse;
    const returnTo = new URL(String(authz.headers['location']), 'http://x').searchParams.get(
      'returnTo',
    )!;
    expect(returnTo).toMatch(/^\/authorize\?request_id=/);
    const rp = new URL(FLOW_REDIRECT).origin;
    const formAction = (res: InjectResponse) =>
      String(res.headers['content-security-policy'])
        .match(/form-action ([^;]*)/)![1]
        .trim();

    const u = await newUser();
    const s = await step1(u.email, ip(), returnTo);
    const page = (await full.app.inject({
      method: 'GET',
      url: '/login/mfa',
      headers: { cookie: s.ticket! },
    })) as InjectResponse;
    expect(page.statusCode).toBe(200);
    expect(formAction(page)).toBe(`'self' ${rp}`);
    const wrong = await step2(s, '000000');
    expect(wrong.statusCode).toBe(400);
    expect(formAction(wrong)).toBe(`'self' ${rp}`);

    for (const other of [
      '/account/sessions',
      `${returnTo}&redirect_uri=https%3A%2F%2Fevil.example`,
    ]) {
      const t = await step1(u.email, ip(), other);
      const p2 = (await full.app.inject({
        method: 'GET',
        url: '/login/mfa',
        headers: { cookie: t.ticket! },
      })) as InjectResponse;
      expect(formAction(p2)).toBe("'self'");
    }
  });
});
