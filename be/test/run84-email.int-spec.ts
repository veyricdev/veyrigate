import type IORedis from 'ioredis';
import type { Model } from 'mongoose';
import { REDIS_CLIENT } from '../src/database/redis/redis.constants';
import { UserService } from '../src/modules/identity/user.service';
import { bootFullApp, type FullApp, type InjectResponse } from './full-app';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';

/**
 * Run 84 T1 (D84.1, DEBT-550/556) on the REAL app over HTTP: `/register` and `/forgot` accept only
 * the narrow `local@domain` grammar. A refused address answers the existing generic 400 page (no
 * echo, `no-store`), creates nothing and sends nothing, whether or not an account exists for it.
 * `/login` keeps the old `@IsEmail()` only (legacy accounts must still sign in).
 */
const HOSTILE: Array<[string, string]> = [
  ['DEBT-556 quoted >', '"x>attacker@evil.test"@good.test'],
  ['DEBT-556 quoted ;', '"a;attacker@evil.test"@good.test'],
  ['quoted plain', '"victim"@good.test'],
  ['percent relay', 'victim%evil.test@good.test'],
  ['bang relay', 'evil.test!victim@good.test'],
  ['IP literal', 'victim@[127.0.0.1]'],
  ['numeric TLD', 'victim@good.123'],
  ['leading space', ' victim@good.test'],
  ['U-label', 'victim@bücher.de'],
];
const PASSWORD = 'correct horse battery';

describe('run 84 T1: deliverable email grammar on register / forgot (real app)', () => {
  let full: FullApp;
  let userModel: Model<Record<string, unknown>>;
  let verifyModel: Model<Record<string, unknown>>;
  let resetModel: Model<Record<string, unknown>>;
  let rlKeys: () => Promise<string[]>;

  const boot = async (): Promise<void> => {
    full = await bootFullApp({ name: 'run84-email' });
    userModel = full.conn.model<Record<string, unknown>>('User');
    verifyModel = full.conn.model<Record<string, unknown>>('EmailVerificationToken');
    resetModel = full.conn.model<Record<string, unknown>>('PasswordResetToken');
    const redis = full.app.get<IORedis>(REDIS_CLIENT);
    rlKeys = () => redis.keys('rl:*');
  };
  let setup: Promise<void> | undefined;
  beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await settled(setup);
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);

  /** GET the form (CSRF cookie + token), then POST it from the same "browser". */
  async function post(path: '/register' | '/forgot' | '/login', fields: Record<string, string>) {
    const page = await full.app.inject({ method: 'GET', url: path });
    expect(page.statusCode).toBe(200);
    const csrf = page.body.match(/name="_csrf" value="([^"]+)"/)![1];
    const cookies = Object.fromEntries(page.cookies.map((c) => [c.name, c.value]));
    const res = await full.app.inject({
      method: 'POST',
      url: path,
      cookies,
      payload: { _csrf: csrf, ...fields },
    });
    // Mail is fire-and-forget after the reply: let it land in the outbox first.
    await new Promise((r) => setImmediate(r));
    return res;
  }

  const totals = async () => ({
    users: await userModel.countDocuments({}),
    verify: await verifyModel.countDocuments({}),
    reset: await resetModel.countDocuments({}),
    mails: full.outbox.length,
  });

  const expectRefused = (res: InjectResponse, email: string) => {
    expect(res.statusCode).toBe(400);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('Request failed');
    expect(res.body).toContain('The request could not be completed.');
    expect(res.body).not.toContain('evil.test');
    expect(res.body).not.toContain('good.test');
    expect(res.body).not.toContain(email);
  };

  it.each(HOSTILE)(
    'register %s => 400 generic page, 0 user, 0 token, 0 mail, no rate-limit hit',
    async (_n, email) => {
      const before = await totals();
      const rlBefore = (await rlKeys()).length;
      const res = await post('/register', { email, password: PASSWORD });
      expectRefused(res, email);
      expect(await totals()).toEqual(before);
      expect((await rlKeys()).length).toBe(rlBefore);
    },
  );

  it.each(HOSTILE)(
    'forgot %s for an EXISTING legacy account => same 400, 0 reset token, 0 mail (no enumeration)',
    async (_n, email) => {
      // A legacy row stored before D84.1 (service write, no DTO): the refusal must not depend on it.
      await full.app
        .get(UserService)
        .createWithPasswordHash(email, 'legacy-hash')
        .catch(() => undefined);
      const withAccount = await totals();
      const res = await post('/forgot', { email });
      expectRefused(res, email);
      expect(await totals()).toEqual(withAccount);
      const unknown = await post('/forgot', { email: email.replace('victim', 'nobody') });
      expect(unknown.statusCode).toBe(res.statusCode);
      expect(unknown.body).toBe(res.body);
      expect(await totals()).toEqual(withAccount);
    },
  );

  it('valid address: register => 201 "Check your email" + exactly one verify mail to that address', async () => {
    const email = `run84-ok.${Date.now()}+tag@sub.example.com`;
    const before = await totals();
    const res = await post('/register', { email, password: PASSWORD });
    expect(res.statusCode).toBe(201);
    expect(res.body).toContain('Check your email');
    const after = await totals();
    expect(after).toEqual({
      ...before,
      users: before.users + 1,
      verify: before.verify + 1,
      mails: before.mails + 1,
    });
    expect(full.outbox.at(-1)!.to).toBe(email.toLowerCase());
  });

  it('valid address: forgot for an existing account => 201 + exactly one reset mail', async () => {
    const email = `o'brien.${Date.now()}@example.io`;
    await full.app.get(UserService).createWithPasswordHash(email, 'legacy-hash');
    const before = await totals();
    const res = await post('/forgot', { email });
    expect(res.statusCode).toBe(201);
    expect(res.body).toContain('Check your email');
    expect(await totals()).toEqual({ ...before, reset: before.reset + 1, mails: before.mails + 1 });
    expect(full.outbox.at(-1)!.to).toBe(email.toLowerCase());
  });

  it('characterization: /login with a quoted local part keeps the old path (generic login failure, not the grammar 400)', async () => {
    const res = await post('/login', {
      email: '"x>attacker@evil.test"@good.test',
      password: PASSWORD,
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('evil.test');
  });
});
