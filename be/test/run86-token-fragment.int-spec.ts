import { randomUUID } from 'node:crypto';
import { buildCsp } from '../src/common/http/csp';
import { AuthenticationService } from '../src/modules/authentication/authentication.service';
import { UserService } from '../src/modules/identity/user.service';
import { FULL_APP_ISSUER, bootFullApp, type FullApp, type InjectResponse } from './full-app';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';
import { tokenFromMailLink } from './helpers/mail-token';

/**
 * Run 86 T1 (DEBT-577, D86.1–D86.3) on the REAL app: the verify/reset token rides in the URL
 * fragment (never the query, so never a request line, access log or Referer); GET ignores
 * `?token=`; the page has exactly one visible code field that `/assets/token-fragment.js` fills;
 * the mail prints the code; POST consumes the (trimmed) body token once.
 */
const GOOD = 'x7#Qm2!vLp9@zR4w';
const NEW = 'r86-a-brand-new-password!';
const MARK = 'R86MARKtokenINqueryMUSTnotREFLECTxxxxxxxxxx';

const setCookies = (res: InjectResponse): string[] =>
  ([] as string[]).concat((res.headers['set-cookie'] as string | string[] | undefined) ?? []);
const csrfOf = (res: InjectResponse): string => res.body.match(/name="_csrf" value="([^"]+)"/)![1];

describe('run 86 T1: one-time token in the URL fragment (real app)', () => {
  let full: FullApp;
  const boot = async (): Promise<void> => {
    full = await bootFullApp({ name: 'run86-fragment' });
  };
  let setup: Promise<void> | undefined;
  beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await settled(setup);
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);

  const flushMail = () => new Promise((resolve) => setImmediate(resolve));
  const get = (url: string) => full.app.inject({ method: 'GET', url }) as Promise<InjectResponse>;
  const submit = async (page: string, fields: Record<string, string>) => {
    const form = await get(page);
    const anon = setCookies(form)
      .find((c) => c.startsWith('idp_csrf='))!
      .split(';')[0];
    return full.app.inject({
      method: 'POST',
      url: page,
      headers: { cookie: anon },
      payload: { _csrf: csrfOf(form), ...fields },
    }) as Promise<InjectResponse>;
  };
  const newUser = async () => {
    const email = `r86f-${randomUUID()}@example.com`;
    await full.app.get(UserService).create({ email, password: GOOD });
    return email;
  };
  const resetMail = async (email: string) => {
    await full.app.get(AuthenticationService).forgotPassword(email);
    await flushMail();
    return full.outbox.filter((m) => m.to === email).at(-1)!;
  };

  it('AC1/AC2: reset and verify links carry #token=<43>, no query; the mail prints the code', async () => {
    const email = await newUser();
    const reset = await resetMail(email);
    const resetLink = reset.text.match(/https?:\/\/\S+/)![0];
    expect(resetLink).toMatch(new RegExp(`^${FULL_APP_ISSUER}/reset#token=[A-Za-z0-9_-]{43}$`));
    expect(resetLink).not.toContain('?');
    const code = tokenFromMailLink(reset.text);
    expect(reset.text).toContain(
      `If the link does not open the form, enter this code on the page: ${code}`,
    );
    expect(reset.html).toContain(`<code>${code}</code>`);

    const fresh = `r86f-${randomUUID()}@example.com`;
    await full.app.get(AuthenticationService).register(fresh, GOOD);
    await flushMail();
    const verify = full.outbox.filter((m) => m.to === fresh).at(-1)!;
    const verifyLink = verify.text.match(/https?:\/\/\S+/)![0];
    expect(verifyLink).toMatch(
      new RegExp(`^${FULL_APP_ISSUER}/verify-email#token=[A-Za-z0-9_-]{43}$`),
    );
    expect(verify.text).toContain(`enter this code on the page: ${tokenFromMailLink(verify.text)}`);
  });

  it.each(['/reset', '/verify-email'])(
    'AC3: GET %s?token=S ignores the query: no S, one empty code field, the fragment script',
    async (path) => {
      const res = await get(`${path}?token=${MARK}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(MARK);
      expect(res.body.match(/name="token"/g)).toHaveLength(1);
      expect(res.body).toMatch(/<input[^>]*name="token"[^>]*value=""/);
      expect(res.body).not.toMatch(/<input[^>]*name="token"[^>]*type="hidden"/);
      expect(res.body).toContain('id="token-manual"');
      // DEBT-605: no `pattern` (invalid under the `v` flag) nor `maxlength` (would cut a pasted code
      // with spaces before the server trims it).
      const field = /<input[^>]*name="token"[^>]*>/.exec(res.body)![0];
      expect(field).not.toMatch(/\spattern=/);
      expect(field).not.toMatch(/\smaxlength=/);
      expect(field).toMatch(/\srequired[\s>]/);
      expect(res.body).toContain('Code from the email');
      expect(res.body).toContain('<script src="/assets/token-fragment.js"></script>');
      expect(res.body).not.toContain('<noscript');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-security-policy']).toBe(buildCsp());
    },
  );

  it('AC4: GET /assets/token-fragment.js => 200 JavaScript, no Set-Cookie', async () => {
    const res = await get('/assets/token-fragment.js');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body).toContain('history.replaceState');
    expect(res.body).toContain('/^#token=([A-Za-z0-9_-]{43})$/');
  });

  it('AC5: POST /reset consumes a pasted code with surrounding spaces once; replay fails', async () => {
    const email = await newUser();
    const code = tokenFromMailLink((await resetMail(email)).text);
    const ok = await submit('/reset', { token: `  ${code}\n`, password: NEW });
    expect(ok.statusCode).toBe(201);
    expect(ok.body).toContain('Password changed');
    const replay = await submit('/reset', { token: code, password: `${NEW}2` });
    expect(replay.statusCode).toBeGreaterThanOrEqual(400);
    const login = await full.app
      .get(AuthenticationService)
      .login(email, NEW, { ip: '198.51.100.86' });
    expect(login).toBeDefined();
  });

  it('AC5: POST /verify-email consumes a pasted code with surrounding spaces', async () => {
    const email = `r86f-${randomUUID()}@example.com`;
    await full.app.get(AuthenticationService).register(email, GOOD);
    await flushMail();
    const code = tokenFromMailLink(full.outbox.filter((m) => m.to === email).at(-1)!.text);
    const ok = await submit('/verify-email', { token: ` ${code} ` });
    expect(ok.statusCode).toBe(201);
    expect((await full.app.get(UserService).findByEmail(email))?.emailVerifiedAt).toBeInstanceOf(
      Date,
    );
  });
});
