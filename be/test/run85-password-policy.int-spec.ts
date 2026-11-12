import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { AuthenticationService } from '../src/modules/authentication/authentication.service';
import { UserService } from '../src/modules/identity/user.service';
import { bootFullApp, type FullApp, type InjectResponse } from './full-app';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';
import { tokenFromMailLink } from './helpers/mail-token';

/**
 * Run 85 T3 (DEBT-574, D85.4) on the REAL app over HTTP: `/register` and `/reset` refuse a password
 * from the embedded common list (or built from product words), with one fixed 400 page that does not
 * depend on whether the email exists; a refused reset does NOT consume the token.
 */
const COMMON = 'password123'; // in the NCSC list (and lowercase, 8-128)
const GOOD = 'x7#Qm2!vLp9@zR4w';

const setCookies = (res: InjectResponse): string[] =>
  ([] as string[]).concat((res.headers['set-cookie'] as string | string[] | undefined) ?? []);
const csrfOf = (res: InjectResponse): string => res.body.match(/name="_csrf" value="([^"]+)"/)![1];

describe('run 85 T3: common-password policy on register/reset (real app)', () => {
  let full: FullApp;

  const boot = async (): Promise<void> => {
    full = await bootFullApp({ name: 'run85-pwpolicy' });
  };
  let setup: Promise<void> | undefined;
  beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await settled(setup);
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);
  afterEach(() => jest.restoreAllMocks());

  /** GET `page` then POST `url` with its CSRF pair. */
  const submit = async (
    page: string,
    url: string,
    fields: Record<string, string>,
  ): Promise<InjectResponse> => {
    const form = await full.app.inject({ method: 'GET', url: page });
    const anon = setCookies(form)
      .find((c) => c.startsWith('idp_csrf='))!
      .split(';')[0];
    return full.app.inject({
      method: 'POST',
      url,
      headers: { cookie: anon },
      payload: { _csrf: csrfOf(form), ...fields },
    }) as Promise<InjectResponse>;
  };
  const flushMail = () => new Promise((resolve) => setImmediate(resolve));

  it('register with a common password: 400, no user, no mail, same page as for an existing email', async () => {
    const fresh = `r85p-${randomUUID()}@example.com`;
    const existing = `r85p-${randomUUID()}@example.com`;
    await full.app.get(UserService).create({ email: existing, password: GOOD });
    const mails = full.outbox.length;

    const a = await submit('/register', '/register', { email: fresh, password: COMMON });
    const b = await submit('/register', '/register', { email: existing, password: COMMON });
    const c = await submit('/register', '/register', { email: fresh, password: 'veyrigate-2026!' });
    await flushMail();
    for (const res of [a, b, c]) expect(res.statusCode).toBe(400);
    expect(b.body).toBe(a.body);
    expect(c.body).toBe(a.body);
    expect(a.body).not.toContain(COMMON);
    expect(await full.conn.model('User').countDocuments({ email: fresh })).toBe(0);
    expect(full.outbox.length).toBe(mails);

    // Control: a strong password registers (201 + verification mail).
    expect(
      (await submit('/register', '/register', { email: fresh, password: GOOD })).statusCode,
    ).toBe(201);
    await flushMail();
    expect(full.outbox.filter((m) => m.to === fresh)).toHaveLength(1);
  });

  it('reset with a common password: 400 and the token is NOT consumed (a good password then works)', async () => {
    const email = `r85p-${randomUUID()}@example.com`;
    await full.app.get(UserService).create({ email, password: GOOD });
    await full.app.get(AuthenticationService).forgotPassword(email);
    await flushMail();
    const mail = full.outbox.filter((m) => m.to === email).at(-1)!;
    const token = tokenFromMailLink(mail.text);

    const refused = await submit('/forgot', '/reset', { token, password: COMMON });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).not.toContain(COMMON);
    expect(
      await full.conn.model('PasswordResetToken').countDocuments({ usedAt: { $ne: null } }),
    ).toBe(0);

    const ok = await submit('/forgot', '/reset', { token, password: 'n3w#Strong!Pass-77' });
    expect(ok.statusCode).toBe(201);
  });
});
