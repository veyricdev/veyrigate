import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { UserService } from '../src/modules/identity/user.service';
import { AuthenticationService } from '../src/modules/authentication/authentication.service';
import { MFA_KEYRING, type MfaKeyring } from '../src/modules/mfa/mfa-crypto';
import { MFA_FAILURE_CAP } from '../src/modules/mfa/mfa.service';
import { totpAt, totpStep } from '../src/modules/mfa/totp';
import { ALERT_ACTIONS, AuditAction } from '../src/modules/security/audit/audit-action.enum';
import { bootFullApp, type FullApp, type InjectResponse } from './full-app';
import { enrollForTest } from './helpers/mfa';
import { tokenFromMailLink } from './helpers/mail-token';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';
import { resetByToken } from './helpers/reset-ticket';

/**
 * Run 89 DEBT-640 (D89.25) on the REAL app: a cap on CONSECUTIVE wrong second-factor codes per user
 * (over every ticket, window and path). At the cap authenticator codes are refused (even a right
 * one) with one alerting audit + a mail; a recovery code, a password reset or an admin MFA reset
 * ends it, so a password holder cannot lock the owner out for good. Any right code resets the count.
 */
const PASSWORD = 'r89c-Current#Pass-1';
const SEED = Buffer.from('r89-mfa-cap-seed!!!!', 'ascii');
const SUSPENDED = 'Authenticator codes are blocked';

const setCookies = (res: InjectResponse): string[] =>
  ([] as string[]).concat((res.headers['set-cookie'] as string | string[] | undefined) ?? []);
const pairOf = (res: InjectResponse, name: string) =>
  setCookies(res)
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0];
const csrfOf = (res: InjectResponse): string => res.body.match(/name="_csrf" value="([^"]+)"/)![1];
const code = (offset = 0) => totpAt(SEED, totpStep(Date.now()) + offset);

describe('run 89 DEBT-640: consecutive second-factor failure cap (real app)', () => {
  let full: FullApp;
  let setup: Promise<void> | undefined;
  beforeAll(
    () => (setup = (async () => void (full = await bootFullApp({ name: 'run89-mfa-cap' })))()),
    INT_SETUP_TIMEOUT_MS,
  );
  afterAll(async () => {
    await settled(setup);
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);

  const newUser = async (failures?: number) => {
    const email = `r89c-${randomUUID()}@fixture.test`;
    const users = full.app.get(UserService);
    const u = await users.create({ email, password: PASSWORD });
    await users.verifyEmail(u.sub);
    await full.conn
      .model('UserTenant')
      .create({ userId: new Types.ObjectId(u.sub), tenantId: DEFAULT_TENANT_ID, status: 'active' });
    const { codes } = await enrollForTest(
      full.conn,
      full.app.get<MfaKeyring>(MFA_KEYRING),
      u.sub,
      SEED,
    );
    if (failures !== undefined) await setFailures(u.sub, failures);
    return { email, sub: u.sub, codes };
  };
  const setFailures = (sub: string, n: number) =>
    full.conn
      .collection('users')
      .updateOne({ _id: new Types.ObjectId(sub) }, { $set: { 'mfa.failures': n } });
  const failuresOf = async (sub: string) =>
    (await full.conn.collection('users').findOne({ _id: new Types.ObjectId(sub) }))?.mfa
      ?.failures as number | undefined;
  const ip = () => `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  /** `/login` then `/login/mfa` with `value`. */
  const signIn = async (email: string, value: string, password = PASSWORD) => {
    const from = ip();
    const page = (await full.app.inject({
      method: 'GET',
      url: '/login',
      remoteAddress: from,
    })) as InjectResponse;
    const s1 = (await full.app.inject({
      method: 'POST',
      url: '/login',
      remoteAddress: from,
      headers: { cookie: pairOf(page, 'idp_csrf')! },
      payload: { _csrf: csrfOf(page), email, password },
    })) as InjectResponse;
    const ticket = pairOf(s1, 'idp_mfa')!;
    const form = (await full.app.inject({
      method: 'GET',
      url: '/login/mfa',
      headers: { cookie: ticket },
    })) as InjectResponse;
    return full.app.inject({
      method: 'POST',
      url: '/login/mfa',
      remoteAddress: from,
      headers: { cookie: ticket },
      payload: { _csrf: csrfOf(form), code: value },
    }) as Promise<InjectResponse>;
  };
  const audits = (sub: string, action: AuditAction) =>
    full.conn
      .model('AuditLog')
      .find({ action, targetId: sub })
      .lean<Array<Record<string, unknown>>>()
      .exec();

  it('cap <= 100 (NIST 800-63B 5.2.2); a wrong code counts, a right code resets the count', async () => {
    expect(MFA_FAILURE_CAP).toBeGreaterThan(10);
    expect(MFA_FAILURE_CAP).toBeLessThanOrEqual(100);
    const u = await newUser(3);
    expect((await signIn(u.email, '000000')).statusCode).toBe(400);
    expect(await failuresOf(u.sub)).toBe(4);
    expect((await signIn(u.email, code())).statusCode).toBe(303);
    expect(await failuresOf(u.sub)).toBeUndefined();
  });

  it('reaching the cap => one alerting AUTH_MFA_LOCKED + one mail; then even the right TOTP is refused with a fixed text; a recovery code signs in and ends it', async () => {
    const u = await newUser(MFA_FAILURE_CAP - 1);
    const before = full.outbox.length;
    expect((await signIn(u.email, '000000')).statusCode).toBe(400);
    expect(await failuresOf(u.sub)).toBe(MFA_FAILURE_CAP);
    const locked = await audits(u.sub, AuditAction.AUTH_MFA_LOCKED);
    expect(locked).toHaveLength(1);
    expect(ALERT_ACTIONS.has(AuditAction.AUTH_MFA_LOCKED)).toBe(true);
    const mails = full.outbox.slice(before).filter((m) => m.to === u.email);
    expect(mails.map((m) => m.subject)).toEqual([
      'Authenticator codes are blocked on your account',
    ]);

    const right = await signIn(u.email, code(-1));
    expect(right.statusCode).toBe(400);
    expect(right.body).toContain(SUSPENDED);
    // DEBT-646: a password reset no longer lifts the block (D89.28): never advise it.
    expect(right.body).not.toMatch(/reset your password/i);
    expect(right.body).toContain('If you have none left, contact your administrator.');
    expect(pairOf(right, 'idp_session')).toBeUndefined();
    // Further failures do not re-alert.
    await signIn(u.email, '111111');
    expect(await audits(u.sub, AuditAction.AUTH_MFA_LOCKED)).toHaveLength(1);

    const recovered = await signIn(u.email, u.codes[0]);
    expect(recovered.statusCode).toBe(303);
    expect(pairOf(recovered, 'idp_session')).toBeDefined();
    expect(await failuresOf(u.sub)).toBeUndefined();
    expect((await signIn(u.email, code(1))).statusCode).toBe(303);
  });

  it('D89.28 a password reset does NOT end the block (mailbox + password holder); a recovery code still does', async () => {
    const u = await newUser(MFA_FAILURE_CAP);
    const auth = full.app.get(AuthenticationService);
    const before = full.outbox.length;
    await auth.forgotPassword(u.email);
    await auth.drainBackgroundWrites(); // run 90 C2
    const mail = full.outbox.slice(before).find((m) => m.to === u.email)!;
    await resetByToken(auth, tokenFromMailLink(mail.text), 'r89c-New#Pass-2');
    expect(await failuresOf(u.sub)).toBe(MFA_FAILURE_CAP);
    const blocked = await signIn(u.email, code(), 'r89c-New#Pass-2');
    expect(blocked.statusCode).toBe(400);
    expect(blocked.body).toContain(SUSPENDED);
    expect((await signIn(u.email, u.codes[0], 'r89c-New#Pass-2')).statusCode).toBe(303);
    expect(await failuresOf(u.sub)).toBeUndefined();
  });

  it('account path: a wrong TOTP at /account/mfa/disable reaching the cap => AUTH_MFA_LOCKED {via:account}; then TOTP suspended there; a recovery code still turns it off', async () => {
    const u = await newUser();
    const signed = await signIn(u.email, code(-1));
    const jar = pairOf(signed, 'idp_session')!;
    await setFailures(u.sub, MFA_FAILURE_CAP - 1);
    const disable = async (value: string) => {
      const page = (await full.app.inject({
        method: 'GET',
        url: '/account/mfa',
        headers: { cookie: jar },
      })) as InjectResponse;
      return full.app.inject({
        method: 'POST',
        url: '/account/mfa/disable',
        headers: { cookie: jar },
        payload: { _csrf: csrfOf(page), current_password: PASSWORD, code: value },
      }) as Promise<InjectResponse>;
    };
    expect((await disable('000000')).statusCode).toBe(400);
    const locked = await audits(u.sub, AuditAction.AUTH_MFA_LOCKED);
    expect(locked).toHaveLength(1);
    expect(locked[0]).toMatchObject({ metadata: { via: 'account', failures: MFA_FAILURE_CAP } });
    const suspended = await disable(code(0));
    expect(suspended.statusCode).toBe(400);
    expect(suspended.body).toContain(SUSPENDED);
    expect((await disable(u.codes[2])).statusCode).toBe(200);
  });

  it('lockout mail tells the owner someone knows the password', async () => {
    const u = await newUser(MFA_FAILURE_CAP - 1);
    const before = full.outbox.length;
    await signIn(u.email, '000000');
    const mail = full.outbox.slice(before).find((m) => m.to === u.email)!;
    expect(mail.text).toMatch(/someone (else )?knows your password/i);
  });
});
