import { jest } from '@jest/globals';
import { randomBytes, randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { sha256, verifyPassword } from '../src/common/crypto/crypto.util';
import { AuthenticationService } from '../src/modules/authentication/authentication.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { ADMIN_LOCKED_UNTIL, UserService } from '../src/modules/identity/user.service';
import { AuditAction } from '../src/modules/security/audit/audit-action.enum';
import { SessionService } from '../src/modules/sessions/session.service';
import {
  authorizeCode,
  bootFullApp,
  FLOW_API_AUD,
  FLOW_REDIRECT,
  formPost,
  seedFlowClient,
  type FullApp,
  type InjectResponse,
} from './full-app';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';
import { seedConsent } from './oauth-fixtures';
import { tokenFromMailLink } from './helpers/mail-token';

/**
 * Run 85 T5 (DEBT-573, contract D85.6) on the REAL app over HTTP: `GET/POST /account/password`.
 * CSRF bound to the session, live session required, current password + new password (policy
 * D85.4), a 5/15' failure bucket per user reserved before Argon2, compare-and-set on the old hash,
 * then EVERY credential is revoked (all sessions incl. the current one, every refresh family, every
 * trusted device) and a notification mail without any token is sent. Reset sends the same mail.
 */
const PASSWORD = 'r85c-Current#Pass-1';
const NEW_PASSWORD = 'r85c-Brand#New-Pass-2';
const SCOPE = 'openid email offline_access api.read';

const setCookies = (res: InjectResponse): string[] =>
  ([] as string[]).concat((res.headers['set-cookie'] as string | string[] | undefined) ?? []);
const pairOf = (res: InjectResponse, name: string) =>
  setCookies(res)
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0];
const csrfOf = (res: InjectResponse): string => res.body.match(/name="_csrf" value="([^"]+)"/)![1];

/** Spy counting Argon2 verifications (login + current-password check). */
const argon2Spy = () =>
  jest.spyOn(
    AuthenticationService.prototype as unknown as {
      passwordMatches(hash: string, password: string): Promise<boolean>;
    },
    'passwordMatches',
  );

describe('run 85 T5: change password /account/password (real app)', () => {
  let full: FullApp;
  let bff: { clientId: string; secret: string };

  const boot = async (): Promise<void> => {
    full = await bootFullApp({ name: 'run85-pwchange' });
    bff = await seedFlowClient(full);
  };
  let setup: Promise<void> | undefined;
  beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await settled(setup);
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);
  afterEach(() => jest.restoreAllMocks());

  const newUser = async (password: string | null = PASSWORD) => {
    const email = `r85c-${randomUUID()}@fixture.test`;
    const users = full.app.get(UserService);
    const u = await users.create({ email, ...(password ? { password } : {}) });
    await users.verifyEmail(u.sub);
    await full.conn
      .model('UserTenant')
      .create({ userId: new Types.ObjectId(u.sub), tenantId: DEFAULT_TENANT_ID, status: 'active' });
    return { email, sub: u.sub };
  };

  const ip = () => `198.51.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

  /** Real browser sign-in; returns the cookie jar header (session + device cookie). */
  const login = async (email: string, password = PASSWORD, from = ip()) => {
    const page = await full.app.inject({ method: 'GET', url: '/login', remoteAddress: from });
    const anon = pairOf(page as InjectResponse, 'idp_csrf')!;
    const res = (await full.app.inject({
      method: 'POST',
      url: '/login',
      remoteAddress: from,
      headers: { cookie: anon },
      payload: { _csrf: csrfOf(page as InjectResponse), email, password, returnTo: '/' },
    })) as InjectResponse;
    const session = pairOf(res, 'idp_session');
    const device = pairOf(res, 'idp_dc');
    return { res, session, device, jar: [session, device].filter(Boolean).join('; ') };
  };

  const getPage = (cookie?: string) =>
    full.app.inject({
      method: 'GET',
      url: '/account/password',
      headers: cookie ? { cookie } : {},
    }) as Promise<InjectResponse>;

  /** GET the form with `jar`, then POST it (CSRF of that page unless overridden). */
  const change = async (
    jar: string,
    fields: { current_password: string; new_password: string },
    csrf?: string,
  ) => {
    const form = await getPage(jar);
    return full.app.inject({
      method: 'POST',
      url: '/account/password',
      headers: { cookie: jar },
      payload: { _csrf: csrf ?? csrfOf(form), ...fields },
    }) as Promise<InjectResponse>;
  };

  const hashOf = async (sub: string) =>
    (
      await full.conn
        .model('User')
        .findById(sub)
        .select('+passwordHash')
        .lean<{ passwordHash?: string }>()
        .exec()
    )?.passwordHash;
  const audits = (sub: string) =>
    full.conn
      .model('AuditLog')
      .find({ action: AuditAction.AUTH_PASSWORD_CHANGED, actorId: sub })
      .lean<Array<Record<string, unknown>>>()
      .exec();
  const flushMail = () => new Promise((resolve) => setImmediate(resolve));

  it('(1) no session: GET => 302 /login?returnTo; POST without CSRF => 403, with anon CSRF => 302 /login', async () => {
    const get = await getPage();
    expect(get.statusCode).toBe(302);
    expect(get.headers['location']).toBe('/login?returnTo=%2Faccount%2Fpassword');

    const noCsrf = await full.app.inject({
      method: 'POST',
      url: '/account/password',
      payload: { current_password: PASSWORD, new_password: NEW_PASSWORD },
    });
    expect(noCsrf.statusCode).toBe(403);

    const loginPage = (await full.app.inject({ method: 'GET', url: '/login' })) as InjectResponse;
    const anon = pairOf(loginPage, 'idp_csrf')!;
    const anonPost = await full.app.inject({
      method: 'POST',
      url: '/account/password',
      headers: { cookie: anon },
      payload: { _csrf: csrfOf(loginPage), current_password: PASSWORD, new_password: NEW_PASSWORD },
    });
    expect(anonPost.statusCode).toBe(302);
    expect(String(anonPost.headers['location'])).toMatch(/^\/login/);
  });

  it('(1b) a CSRF token of another identity (another session) => 403, nothing changes', async () => {
    const a = await newUser();
    const b = await newUser();
    const sa = await login(a.email);
    const sb = await login(b.email);
    const csrfOfB = csrfOf(await getPage(sb.jar));
    const before = await hashOf(a.sub);
    const res = await change(
      sa.jar,
      { current_password: PASSWORD, new_password: NEW_PASSWORD },
      csrfOfB,
    );
    expect(res.statusCode).toBe(403);
    expect(await hashOf(a.sub)).toBe(before);
  });

  it('GET with a session renders the no-store form with CSRF; home links to it', async () => {
    const u = await newUser();
    const s = await login(u.email);
    const page = await getPage(s.jar);
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.body).toContain('name="current_password"');
    expect(page.body).toContain('name="new_password"');
    expect(page.body).toContain('name="_csrf"');
    const home = await full.app.inject({ method: 'GET', url: '/', headers: { cookie: s.jar } });
    expect(home.body).toContain('href="/account/password"');
  });

  it('(2) wrong current password => 400 form, hash unchanged, audit invalid_current, nothing revoked', async () => {
    const u = await newUser();
    const s = await login(u.email);
    const before = await hashOf(u.sub);
    const res = await change(s.jar, {
      current_password: 'not-the-password',
      new_password: NEW_PASSWORD,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('The current password is incorrect.');
    expect(res.body).toContain('name="current_password"');
    expect(res.body).not.toContain('not-the-password');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(await hashOf(u.sub)).toBe(before);
    expect(await audits(u.sub)).toEqual([
      expect.objectContaining({ result: 'failure', reason: 'invalid_current' }),
    ]);
    expect((await full.app.get(SessionService).get(s.session!.split('=')[1])) !== null).toBe(true);
  });

  it('(3) the 6th failure within 900 s => 429 without Argon2', async () => {
    const u = await newUser();
    const s = await login(u.email);
    for (let i = 0; i < 5; i++) {
      const r = await change(s.jar, {
        current_password: `wrong-${i}-pass`,
        new_password: NEW_PASSWORD,
      });
      expect(r.statusCode).toBe(400);
    }
    const spy = argon2Spy();
    const blocked = await change(s.jar, { current_password: PASSWORD, new_password: NEW_PASSWORD });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(spy).not.toHaveBeenCalled();
    const throttled = (await audits(u.sub)).filter((a) => a.reason === 'throttled');
    expect(throttled).toHaveLength(1);
  });

  it('(4) a new password from the list, or containing the email local part => 400, hash unchanged', async () => {
    const u = await newUser();
    const s = await login(u.email);
    const before = await hashOf(u.sub);
    const local = u.email.split('@')[0];
    for (const bad of ['password123', `${local}#2026`]) {
      const res = await change(s.jar, { current_password: PASSWORD, new_password: bad });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('Choose a less common password.');
      expect(res.body).not.toContain(bad);
    }
    expect(await hashOf(u.sub)).toBe(before);
    expect((await audits(u.sub)).map((a) => a.reason)).toEqual(['policy', 'policy']);
    // Policy refusals give the reservation back: 5 more wrong guesses are still allowed.
    for (let i = 0; i < 5; i++) {
      expect(
        (await change(s.jar, { current_password: `wrong-${i}-pass`, new_password: NEW_PASSWORD }))
          .statusCode,
      ).toBe(400);
    }
  });

  it('(5) success: every credential dies, old password refused, mail without token, no-store', async () => {
    const u = await newUser();
    const a = await login(u.email); // the browser that changes the password
    const b = await login(u.email); // another browser of the same user
    await seedConsent(full.conn, {
      userId: u.sub,
      clientId: bff.clientId,
      resource: FLOW_API_AUD,
      scopes: SCOPE.split(' '),
    });
    const verifier = randomBytes(32).toString('base64url');
    const code = await authorizeCode(full, {
      clientId: bff.clientId,
      sessionId: b.session!.split('=')[1],
      resource: FLOW_API_AUD,
      scope: SCOPE,
      verifier,
    });
    const tokens = (
      await formPost(full, '/token', bff, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: FLOW_REDIRECT,
        code_verifier: verifier,
        resource: FLOW_API_AUD,
      })
    ).json<{ access_token: string; refresh_token: string }>();
    expect(tokens.refresh_token).toBeTruthy();
    const mails = full.outbox.length;
    const verifiedBefore = (await full.app.get(UserService).findById(u.sub))!.emailVerifiedAt;

    const res = await change(a.jar, { current_password: PASSWORD, new_password: NEW_PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain(
      'Your password has been changed. Sign in again with your new password.',
    );
    expect(setCookies(res).some((c) => /^idp_session=;/.test(c) && /Max-Age=0/i.test(c))).toBe(
      true,
    );
    expect(await verifyPassword((await hashOf(u.sub))!, NEW_PASSWORD)).toBe(true);
    // The write touches only passwordHash (no emailVerifiedAt, no lock state).
    const after = (await full.app.get(UserService).findById(u.sub))!;
    expect(after.emailVerifiedAt).toEqual(verifiedBefore);
    expect(after.lockedUntil).toBeUndefined();

    // Every session (current one too) is dead.
    const sessions = full.app.get(SessionService);
    expect(await sessions.get(a.session!.split('=')[1])).toBeNull();
    expect(await sessions.get(b.session!.split('=')[1])).toBeNull();
    // Refresh family dead; AT carrying the old sid dead at /userinfo.
    const refreshed = await formPost(full, '/token', bff, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    });
    expect(refreshed.statusCode).toBe(400);
    expect(refreshed.json()).toMatchObject({ error: 'invalid_grant' });
    const ui = await full.app.inject({
      method: 'GET',
      url: '/userinfo',
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(ui.statusCode).toBe(401);
    // Trusted devices forgotten.
    const redis = full.app.get(
      (await import('../src/database/redis/redis.service')).RedisService,
    ).client;
    expect(await redis.exists(`dc:{u:${sha256(u.sub)}}`)).toBe(0);

    // Old password refused, new one accepted.
    expect((await login(u.email, PASSWORD)).res.statusCode).toBe(401);
    expect((await login(u.email, NEW_PASSWORD)).res.statusCode).toBe(302);

    expect(await audits(u.sub)).toEqual([
      expect.objectContaining({
        result: 'success',
        metadata: expect.objectContaining({ sessionCount: 2 }),
      }),
    ]);
    await flushMail();
    const sent = full.outbox.slice(mails).filter((m) => m.to === u.email);
    expect(sent).toHaveLength(1);
    expect(sent[0].text + sent[0].html).not.toMatch(/token=|#token/);
    expect(sent[0].text).toContain('/forgot');
    expect(full.outbox.slice(mails).every((m) => m.to === u.email)).toBe(true);
  });

  it('(6) a reset landing between the current-password check and the write => 409, nothing revoked', async () => {
    const u = await newUser();
    const s = await login(u.email);
    const revoke = jest.spyOn(full.app.get(SessionService), 'revokeAllForUser');
    const real = (
      AuthenticationService.prototype as unknown as {
        passwordMatches(h: string, p: string): Promise<boolean>;
      }
    ).passwordMatches;
    argon2Spy().mockImplementation(async function (this: unknown, h: string, p: string) {
      const ok = await real.call(this, h, p);
      await full.conn
        .model('User')
        .updateOne(
          { _id: u.sub },
          { $set: { passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$reset' } },
        );
      return ok;
    });
    const res = await change(s.jar, { current_password: PASSWORD, new_password: NEW_PASSWORD });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('Your password could not be changed. Sign in again and retry.');
    expect(revoke).not.toHaveBeenCalled();
    expect(await hashOf(u.sub)).toBe('$argon2id$v=19$m=19456,t=2,p=1$reset');
    expect((await audits(u.sub)).map((a) => a.reason)).toEqual(['conflict']);
  });

  it('(7) an admin lock landing mid-way => 409, password unchanged', async () => {
    const u = await newUser();
    const s = await login(u.email);
    const before = await hashOf(u.sub);
    const real = (
      AuthenticationService.prototype as unknown as {
        passwordMatches(h: string, p: string): Promise<boolean>;
      }
    ).passwordMatches;
    argon2Spy().mockImplementation(async function (this: unknown, h: string, p: string) {
      const ok = await real.call(this, h, p);
      await full.conn
        .model('User')
        .updateOne({ _id: u.sub }, { $set: { lockedUntil: ADMIN_LOCKED_UNTIL } });
      return ok;
    });
    const res = await change(s.jar, { current_password: PASSWORD, new_password: NEW_PASSWORD });
    expect(res.statusCode).toBe(409);
    expect(await hashOf(u.sub)).toBe(before);
  });

  it('(8) a federation-only user (no password): GET shows the notice, POST => 400 no_password', async () => {
    const u = await newUser(null);
    const sessionId = (await full.app.get(SessionService).create(u.sub, DEFAULT_TENANT_ID)).id;
    const jar = `idp_session=${sessionId}`;
    const page = await getPage(jar);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(
      'This account has no password. Use &quot;Forgot password&quot; to set one.',
    );
    const csrf = csrfOf(
      (await full.app.inject({
        method: 'GET',
        url: '/logout',
        headers: { cookie: jar },
      })) as InjectResponse,
    );
    const res = await full.app.inject({
      method: 'POST',
      url: '/account/password',
      headers: { cookie: jar },
      payload: { _csrf: csrf, current_password: 'anything-at-all', new_password: NEW_PASSWORD },
    });
    expect(res.statusCode).toBe(400);
    expect(await hashOf(u.sub)).toBeUndefined();
    expect((await audits(u.sub)).map((a) => a.reason)).toEqual(['no_password']);
  });

  it('(9) sessions revoke fails => 5xx, the new hash stays, audit revoke_failed (sessions)', async () => {
    const u = await newUser();
    const s = await login(u.email);
    jest
      .spyOn(full.app.get(SessionService), 'revokeAllForUser')
      .mockRejectedValueOnce(new Error('redis down'));
    const res = await change(s.jar, { current_password: PASSWORD, new_password: NEW_PASSWORD });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(await verifyPassword((await hashOf(u.sub))!, NEW_PASSWORD)).toBe(true);
    expect(await audits(u.sub)).toEqual([
      expect.objectContaining({
        result: 'failure',
        reason: 'revoke_failed',
        metadata: { failedStep: 'sessions' },
      }),
    ]);
  });

  it('(10) a successful reset also sends exactly one "password changed" mail', async () => {
    const u = await newUser();
    await full.app.get(AuthenticationService).forgotPassword(u.email);
    await flushMail();
    const link = full.outbox.filter((m) => m.to === u.email).at(-1)!;
    const token = tokenFromMailLink(link.text);
    const mails = full.outbox.length;
    await full.app.get(AuthenticationService).resetPassword(token, NEW_PASSWORD);
    await flushMail();
    const sent = full.outbox.slice(mails);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(u.email);
    expect(sent[0].subject).toBe('Your password was changed');
    expect(sent[0].text + sent[0].html).not.toMatch(/token=|#token/);
  });
});
