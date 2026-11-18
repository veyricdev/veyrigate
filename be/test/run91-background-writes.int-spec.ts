import { jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { AuthenticationService } from '../src/modules/authentication/authentication.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { SessionService } from '../src/modules/sessions/session.service';
import { bootFullApp, type FullApp } from './full-app';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';
import { tokenFromMailLink } from './helpers/mail-token';
import { resetWithToken } from './helpers/reset-ticket';

/**
 * Run 91 lot A on the real app (`AppModule` + `createFastifyAdapter`).
 * T2 / DEBT-666: a failed detached write is counted in `sso_background_write_failures_total{what}`
 * while `/register` answers exactly like the success branch. T3 / DEBT-665 + DEBT-671 (retry 1,
 * D91.4/D91.13/D91.14): `/register` for an existing unverified account sends a RESET link ("finish
 * creating your account") when no reset token is live; `/verify-email` also proves the password; a
 * completed reset marks the email verified only when it was not yet (D91.5). Invariant: verifying a
 * mailbox never activates a password its holder did not prove to know.
 */
type InjectResponse = Awaited<ReturnType<FullApp['app']['inject']>>;
const METRICS_TOKEN = randomBytes(32).toString('hex');

describe('run 91 lot A (background write failures, verification mail recovery)', () => {
  let full: FullApp;
  const lines: string[] = [];
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(...String(chunk).split('\n').filter(Boolean));
      cb();
    },
  });
  let setup: Promise<void> | undefined;
  beforeAll(
    () =>
      (setup = (async () => {
        full = await bootFullApp({ name: 'run91a', env: { METRICS_TOKEN }, logStream });
      })()),
    INT_SETUP_TIMEOUT_MS,
  );
  afterAll(async () => {
    await settled(setup);
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);
  afterEach(() => jest.restoreAllMocks());

  const PASSWORD = 'run91 correct horse battery';
  const cookieOf = (res: InjectResponse, name: string): string | undefined => {
    const raw = res.headers['set-cookie'];
    const all = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
    const hit = all.find((c) => c.startsWith(`${name}=`));
    return hit ? decodeURIComponent(hit.slice(name.length + 1).split(';', 1)[0]) : undefined;
  };
  const post = async (url: string, fields: Record<string, string>) => {
    const page = await full.app.inject({ method: 'GET', url: '/login' });
    return full.app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      cookies: { idp_csrf: cookieOf(page, 'idp_csrf')! },
      payload: new URLSearchParams({
        _csrf: /name="_csrf" value="([^"]+)"/.exec(page.body)![1],
        ...fields,
      }).toString(),
    });
  };
  const email = (tag: string) => `run91-${tag}-${randomBytes(4).toString('hex')}@example.com`;
  const drain = () => full.app.get(AuthenticationService).drainBackgroundWrites();
  const users = () => full.conn.model('User');
  const verifyTokens = () => full.conn.model('EmailVerificationToken');
  const mailsTo = (addr: string) => full.outbox.filter((m) => m.to === addr);
  const metrics = async () => {
    const res = await full.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    return res.body;
  };
  const failures = (body: string, what: string) =>
    new RegExp(`^sso_background_write_failures_total\\{what="${what}"\\} (\\d+)$`, 'm').exec(
      body,
    )?.[1];

  /** A registered (unverified) user, its id, and the success page of a new-email `/register`. */
  const registered = async (tag: string) => {
    const addr = email(tag);
    const res = await post('/register', { email: addr, password: PASSWORD });
    expect(res.statusCode).toBe(201);
    await drain();
    const user = (await users().findOne({ email: addr }).lean()) as { _id: unknown } | null;
    expect(user).not.toBeNull();
    return { addr, userId: user!._id, page: res };
  };
  const liveTokens = (userId: unknown) =>
    verifyTokens().countDocuments({ userId, usedAt: null, expiresAt: { $gt: new Date() } });

  describe('T2 DEBT-666: failed background writes are counted', () => {
    it('/register with a failing user insert: same status + body as success, register series = 1, no email in /metrics', async () => {
      const ok = await registered('ok');
      expect(failures(await metrics(), 'register')).toBe('0');
      const addr = email('fail');
      jest.spyOn(users(), 'create').mockRejectedValueOnce(new Error(`mongo down ${addr}`) as never);
      const res = await post('/register', { email: addr, password: PASSWORD });
      expect(res.statusCode).toBe(ok.page.statusCode);
      expect(res.body).toBe(ok.page.body);
      await drain();
      const body = await metrics();
      expect(failures(body, 'register')).toBe('1');
      for (const w of ['forgot', 'resend_verify', 'auth_mail']) expect(failures(body, w)).toBe('0');
      expect(body).not.toContain(addr);
      expect(body).not.toContain('@example.com');
      expect(await users().countDocuments({ email: addr })).toBe(0);
    });
  });

  describe('T3 DEBT-665 / DEBT-671: unfinished registrations never activate a third-party password (D91.13)', () => {
    const ATTACKER = 'run91 attacker password A';
    const VICTIM_B = 'run91 victim password B';
    const VICTIM_C = 'run91 victim password C';
    const resetTokens = () => full.conn.model('PasswordResetToken');
    const finishMails = (addr: string) =>
      mailsTo(addr).filter((m) => m.subject === 'Finish creating your account');
    const login = async (addr: string, password: string) =>
      (await post('/login', { email: addr, password, returnTo: '/' })).statusCode;
    const verifyToken = (addr: string) => tokenFromMailLink(mailsTo(addr)[0].text);
    const userOf = async (addr: string) =>
      (await users().findOne({ email: addr }).lean()) as {
        _id: { toString(): string };
        emailVerifiedAt?: Date;
      };

    it('pre-hijack through recovery: attacker (V, A), victim registers (V, B) => reset link only; after the reset to C, A and B fail, C works, older sessions are gone', async () => {
      const addr = email('hijack-a');
      const first = await post('/register', { email: addr, password: ATTACKER });
      await drain();
      const { _id } = await userOf(addr);
      await verifyTokens().updateMany(
        { userId: _id },
        { $set: { expiresAt: new Date(Date.now() - 1000) } },
      );
      const sessions = full.app.get(SessionService);
      const before = await sessions.establish(undefined, _id.toString(), DEFAULT_TENANT_ID, {
        amr: ['pwd'],
      });

      const victim = await post('/register', { email: addr, password: VICTIM_B });
      expect(victim.statusCode).toBe(first.statusCode);
      expect(victim.body).toBe(first.body);
      await drain();
      expect(await verifyTokens().countDocuments({ userId: _id })).toBe(1); // no new verify token
      expect(await liveTokens(_id)).toBe(0);
      expect(
        await resetTokens().countDocuments({
          userId: _id,
          usedAt: null,
          expiresAt: { $gt: new Date() },
        }),
      ).toBe(1);
      expect(mailsTo(addr)).toHaveLength(2);
      expect(finishMails(addr)).toHaveLength(1);
      const link = finishMails(addr)[0].text;
      expect(link).toContain('/reset#token=');
      expect(link).not.toContain('/verify-email');

      const reset = await resetWithToken(full.app, tokenFromMailLink(link), VICTIM_C);
      expect(reset.statusCode).toBe(201);
      expect((await userOf(addr)).emailVerifiedAt).toBeInstanceOf(Date);
      expect((await sessions.listByUser(_id.toString())).map((s) => s.ref)).not.toContain(
        before.session.ref,
      );
      expect(await login(addr, ATTACKER)).toBe(401);
      expect(await login(addr, VICTIM_B)).toBe(401);
      expect(await login(addr, VICTIM_C)).toBe(303);
    });

    it('pre-hijack through the FIRST mail: a wrong password never verifies and keeps the token; after 5 wrong ones even the right password is refused', async () => {
      const addr = email('hijack-c');
      await post('/register', { email: addr, password: ATTACKER });
      await drain();
      const token = verifyToken(addr);
      const { _id } = await userOf(addr);

      const wrong = await post('/verify-email', { token, password: VICTIM_B });
      expect(wrong.statusCode).toBe(400);
      expect((await userOf(addr)).emailVerifiedAt ?? null).toBeNull();
      expect(await liveTokens(_id)).toBe(1); // not burnt
      expect(await login(addr, ATTACKER)).toBe(401); // still unverified

      for (let i = 2; i <= 5; i++) {
        expect(
          (await post('/verify-email', { token, password: `${VICTIM_B} ${i}` })).statusCode,
        ).toBe(400);
      }
      // DEBT-672: exhausted by the reservation filter (5 attempts), not by a separate write.
      expect(
        ((await verifyTokens().findOne({ userId: _id }).lean()) as { attempts?: number }).attempts,
      ).toBe(5);
      const sixth = await post('/verify-email', { token, password: ATTACKER });
      expect(sixth.statusCode).toBe(400);
      expect(sixth.body).toBe(wrong.body);
      expect((await userOf(addr)).emailVerifiedAt ?? null).toBeNull();
    });

    it('legitimate owner: register (V, B) then verify with B => 201, verified, login B works', async () => {
      const addr = email('legit');
      await post('/register', { email: addr, password: VICTIM_B });
      await drain();
      const res = await post('/verify-email', { token: verifyToken(addr), password: VICTIM_B });
      expect(res.statusCode).toBe(201);
      expect((await userOf(addr)).emailVerifiedAt).toBeInstanceOf(Date);
      expect(await login(addr, VICTIM_B)).toBe(303);
    });

    it('a live reset token is left => /register again issues nothing', async () => {
      const { addr, userId } = await registered('live');
      await verifyTokens().updateMany({ userId }, { $set: { usedAt: new Date() } });
      await post('/register', { email: addr, password: PASSWORD });
      await drain();
      expect(finishMails(addr)).toHaveLength(1);
      await post('/register', { email: addr, password: PASSWORD });
      await drain();
      expect(await resetTokens().countDocuments({ userId })).toBe(1);
      expect(mailsTo(addr)).toHaveLength(2);
    });

    it('a verified user, or a federation-only (no password) user => nothing is issued', async () => {
      const { addr, userId } = await registered('verified');
      await users().updateOne({ _id: userId }, { $set: { emailVerifiedAt: new Date() } });
      await post('/register', { email: addr, password: PASSWORD });
      const fed = email('fed');
      const fedUser = await users().create({ email: fed, profile: {} });
      await post('/register', { email: fed, password: PASSWORD });
      await drain();
      expect(await resetTokens().countDocuments({ userId: { $in: [userId, fedUser._id] } })).toBe(
        0,
      );
      expect(await verifyTokens().countDocuments({ userId })).toBe(1);
      expect(mailsTo(addr)).toHaveLength(1);
      expect(mailsTo(fed)).toHaveLength(0);
    });

    it('issueToken fails in the recovery branch => resend_verify = 1, the page does not change', async () => {
      const { addr, userId, page } = await registered('resend-fail');
      await verifyTokens().updateMany({ userId }, { $set: { usedAt: new Date() } });
      expect(failures(await metrics(), 'resend_verify')).toBe('0');
      jest.spyOn(resetTokens(), 'create').mockRejectedValueOnce(new Error('mongo down') as never);
      const again = await post('/register', { email: addr, password: PASSWORD });
      expect(again.statusCode).toBe(page.statusCode);
      expect(again.body).toBe(page.body);
      await drain();
      expect(failures(await metrics(), 'resend_verify')).toBe('1');
      expect(await resetTokens().countDocuments({ userId })).toBe(0);
      expect(mailsTo(addr)).toHaveLength(1);
    });

    const resetVia = async (addr: string) => {
      await post('/forgot', { email: addr });
      await drain();
      const mail = mailsTo(addr)
        .filter((m) => /\/reset#token=/.test(m.text))
        .at(-1)!;
      const res = await resetWithToken(full.app, tokenFromMailLink(mail.text), `${PASSWORD} new`);
      expect(res.statusCode).toBe(201);
    };

    it('an unverified user completing /forgot -> /reset becomes verified (D91.5)', async () => {
      const { addr, userId } = await registered('reset-unv');
      await resetVia(addr);
      const after = (await users().findById(userId).lean()) as { emailVerifiedAt?: Date } | null;
      expect(after?.emailVerifiedAt).toBeInstanceOf(Date);
    });

    it('a verified user completing a reset keeps its original emailVerifiedAt', async () => {
      const { addr, userId } = await registered('reset-ver');
      const at = new Date('2026-01-02T03:04:05.000Z');
      await users().updateOne({ _id: userId }, { $set: { emailVerifiedAt: at } });
      await resetVia(addr);
      const after = (await users().findById(userId).lean()) as { emailVerifiedAt?: Date } | null;
      expect(after?.emailVerifiedAt?.toISOString()).toBe(at.toISOString());
    });

    it('no log line or audit event of this file carries a password or a mail token', async () => {
      const secrets = [ATTACKER, VICTIM_B, VICTIM_C, PASSWORD];
      for (const m of full.outbox)
        if (/#token=/.test(m.text)) secrets.push(tokenFromMailLink(m.text));
      const audit = JSON.stringify(await full.conn.model('AuditLog').find({}).lean());
      const logs = lines.join('\n');
      for (const s of secrets) {
        expect(logs).not.toContain(s);
        expect(audit).not.toContain(s);
      }
      expect(logs).not.toMatch(/run91-[a-z-]+-[0-9a-f]{8}@example\.com/);
    });
  });
});
