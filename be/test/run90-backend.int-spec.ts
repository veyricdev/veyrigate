import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { AuthenticationService } from '../src/modules/authentication/authentication.service';
import { bootFullApp, type FullApp } from './full-app';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';
import { tokenFromMailLink } from './helpers/mail-token';

/**
 * Run 90 lot C on the real app (`AppModule` + `createFastifyAdapter` + production pino options).
 * C1 / DEBT-095: one request id source; a safe client `x-request-id` is echoed and is the `requestId`
 * of the audit event and the `req.id` of the access log line of that request; anything else becomes a
 * fresh UUID. C2 / DEBT-659/660: `/register` and `/forgot` detach their existence-dependent writes;
 * the data invariants hold once those writes have settled (one user, one token, one mail).
 */
type InjectResponse = Awaited<ReturnType<FullApp['app']['inject']>>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('run 90 lot C (request id, detached register/forgot writes)', () => {
  let full: FullApp;
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(...String(chunk).split('\n').filter(Boolean));
      cb();
    },
  });

  let setup: Promise<void> | undefined;
  beforeAll(
    () =>
      (setup = (async () => {
        // Run 91 (D91.10): `inject` comes from 127.0.0.1, trusted here, so C1 exercises the client id.
        full = await bootFullApp({
          name: 'run90',
          logStream: stream,
          env: { TRUST_PROXY: '127.0.0.1' },
        });
      })()),
    INT_SETUP_TIMEOUT_MS,
  );
  afterAll(async () => {
    await settled(setup);
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);

  const cookieOf = (res: InjectResponse, name: string): string | undefined => {
    const raw = res.headers['set-cookie'];
    const all = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
    const hit = all.find((c) => c.startsWith(`${name}=`));
    return hit ? decodeURIComponent(hit.slice(name.length + 1).split(';', 1)[0]) : undefined;
  };
  /** A fresh anonymous CSRF pair (cookie + form token) from GET /login. */
  const anon = async () => {
    const page = await full.app.inject({ method: 'GET', url: '/login' });
    return {
      cookie: cookieOf(page, 'idp_csrf')!,
      csrf: /name="_csrf" value="([^"]+)"/.exec(page.body)![1],
    };
  };
  const post = async (
    url: string,
    fields: Record<string, string>,
    headers: Record<string, string> = {},
  ) => {
    const a = await anon();
    return full.app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      cookies: { idp_csrf: a.cookie },
      payload: new URLSearchParams({ _csrf: a.csrf, ...fields }).toString(),
    });
  };
  const email = (tag: string) => `run90-${tag}-${randomBytes(4).toString('hex')}@example.com`;
  const auditByRequestId = (requestId: string) =>
    full.conn.model('AuditLog').find({ requestId }).lean();
  const accessLine = (id: string) =>
    lines
      .map((l) => JSON.parse(l) as { msg?: string; req?: { id?: string } })
      .find((e) => e.msg === 'request completed' && e.req?.id === id);
  const flushLogs = () => new Promise((r) => setTimeout(r, 50));
  const drain = () => full.app.get(AuthenticationService).drainBackgroundWrites();

  describe('C1 request id (DEBT-095)', () => {
    it('a valid client id is echoed and is the audit requestId + access-log req.id of that request', async () => {
      const id = `c1-${randomBytes(6).toString('hex')}.x:y_z`;
      const res = await post(
        '/login',
        { email: email('rid'), password: 'wrong password 123' },
        { 'x-request-id': id },
      );
      expect(res.statusCode).toBe(401);
      expect(res.headers['x-request-id']).toBe(id);
      const events = await auditByRequestId(id);
      expect(events.map((e) => (e as { action?: string }).action)).toContain('AUTH_LOGIN_FAILED');
      await flushLogs();
      expect(accessLine(id)).toBeDefined();
    });

    it.each([
      ['8 KB', 'r'.repeat(8192)],
      ['percent-encoded CR LF', 'abc%0d%0aSet-Cookie:%20pwn=1'],
      ['65 chars', 'a'.repeat(65)],
      ['bad chars', 'a<b>"c'],
    ])(
      'a %s client id is replaced by a fresh UUID, used by audit and log alike',
      async (_n, bad) => {
        const res = await post(
          '/login',
          { email: email('bad'), password: 'wrong password 123' },
          { 'x-request-id': bad },
        );
        expect(res.statusCode).toBe(401);
        const id = String(res.headers['x-request-id']);
        expect(id).toMatch(UUID);
        expect(res.headers['set-cookie']?.toString() ?? '').not.toContain('pwn');
        expect((await auditByRequestId(id)).length).toBeGreaterThan(0);
        expect(await full.conn.model('AuditLog').countDocuments({ requestId: bad })).toBe(0);
        await flushLogs();
        expect(accessLine(id)).toBeDefined();
        expect(lines.some((l) => l.includes(bad))).toBe(false);
      },
    );

    it('an empty header and no header: a UUID each, never the req-N counter', async () => {
      const empty = await full.app.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-request-id': '' },
      });
      const a = await full.app.inject({ method: 'GET', url: '/health' });
      const b = await full.app.inject({ method: 'GET', url: '/health' });
      for (const r of [empty, a, b]) {
        expect(r.statusCode).toBeLessThan(500);
        expect(r.headers['x-request-id']).toMatch(UUID);
      }
      expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
    });
  });

  describe('C2 detached register/forgot writes (DEBT-659/660)', () => {
    const PASSWORD = 'run90 correct horse battery';

    it('/register new email: same page, then exactly one user, membership, verify token and mail', async () => {
      const addr = email('reg');
      const res = await post('/register', { email: addr, password: PASSWORD });
      expect(res.statusCode).toBe(201);
      await drain();
      const user = (await full.conn.model('User').findOne({ email: addr }).lean()) as {
        _id: unknown;
      } | null;
      expect(user).not.toBeNull();
      expect(await full.conn.model('UserTenant').countDocuments({ userId: user!._id })).toBe(1);
      expect(
        await full.conn.model('EmailVerificationToken').countDocuments({ userId: user!._id }),
      ).toBe(1);
      const mails = full.outbox.filter((m) => m.to === addr);
      expect(mails).toHaveLength(1);
      tokenFromMailLink(mails[0].text);
    });

    it('two concurrent /register for one email: both get the page, one user, one token, one mail', async () => {
      const addr = email('race');
      const [r1, r2] = await Promise.all([
        post('/register', { email: addr, password: PASSWORD }),
        post('/register', { email: addr, password: PASSWORD }),
      ]);
      expect([r1.statusCode, r2.statusCode]).toEqual([201, 201]);
      expect(r1.body).toBe(r2.body);
      await drain();
      const users = await full.conn.model('User').find({ email: addr }).lean();
      expect(users).toHaveLength(1);
      expect(
        await full.conn
          .model('EmailVerificationToken')
          .countDocuments({ userId: (users[0] as { _id: unknown })._id }),
      ).toBe(1);
      expect(full.outbox.filter((m) => m.to === addr)).toHaveLength(1);
    });

    // Run 91 (DEBT-665, D91.4 retry 1): an existing UNVERIFIED account gets no new verify token, only one
    // "finish creating your account" reset link (verified accounts get nothing: run91-background-writes).
    it('/register for an existing unverified email: identical page, no new verify token, one finish mail', async () => {
      const addr = email('dup');
      const first = await post('/register', { email: addr, password: PASSWORD });
      await drain();
      const again = await post('/register', { email: addr, password: PASSWORD });
      await drain();
      expect(again.statusCode).toBe(201);
      expect(again.body).toBe(first.body);
      const user = (await full.conn.model('User').find({ email: addr }).lean()) as {
        _id: unknown;
      }[];
      expect(user).toHaveLength(1);
      expect(
        await full.conn.model('EmailVerificationToken').countDocuments({ userId: user[0]._id }),
      ).toBe(1);
      const mails = full.outbox.filter((m) => m.to === addr);
      expect(mails).toHaveLength(2);
      expect(mails[1].subject).toBe('Finish creating your account');
      expect(tokenFromMailLink(mails[1].text)).toBeTruthy();
      expect(mails[1].text).toContain('/reset#token=');
    });

    it('/forgot: known email gets one reset token + mail once settled, unknown gets the same page and nothing', async () => {
      const addr = email('fgt');
      await post('/register', { email: addr, password: PASSWORD });
      await drain();
      const user = (await full.conn.model('User').findOne({ email: addr }).lean()) as {
        _id: unknown;
      };
      const known = await post('/forgot', { email: addr });
      const unknownAddr = email('nobody');
      const unknown = await post('/forgot', { email: unknownAddr });
      expect(known.statusCode).toBe(201);
      expect(unknown.statusCode).toBe(201);
      expect(unknown.body).toBe(known.body);
      await drain();
      expect(await full.conn.model('PasswordResetToken').countDocuments({ userId: user._id })).toBe(
        1,
      );
      const resetMails = full.outbox.filter((m) => m.to === addr && /\/reset#token=/.test(m.text));
      expect(resetMails).toHaveLength(1);
      tokenFromMailLink(resetMails[0].text);
      expect(full.outbox.some((m) => m.to === unknownAddr)).toBe(false);
    });
  });
});
