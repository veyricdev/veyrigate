import { jest } from '@jest/globals';
import { randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { sha256 } from '../src/common/crypto/crypto.util';
import { AuthenticationService } from '../src/modules/authentication/authentication.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { UserService } from '../src/modules/identity/user.service';
import { SessionService } from '../src/modules/sessions/session.service';
import { bootFullApp, type FullApp } from './full-app';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';
import { tokenFromMailLink } from './helpers/mail-token';
import {
  CookieJar,
  csrfOf,
  exchangeResetToken,
  postNewPassword,
  setCookiesOf,
  type InjectResult,
} from './helpers/reset-ticket';

/**
 * Run 94 T1 (DEBT-661, D94.3–D94.8) on the REAL app: the mailed reset token is exchanged, on the
 * user's `Continue` click, for a 15' single-use ticket cookie (`idp_reset`, http mode name); the
 * link left in the browser history is dead afterwards. `POST /reset` takes the ticket only.
 */
const GOOD = 'r94-Original#Pass-1';
const NEW = 'r94-brand-new#Pass-2';
const TICKET_TTL_MS = 15 * 60 * 1000;

interface ResetDoc {
  tokenHash: string;
  userId: unknown;
  ticketHash?: string | null;
  usedAt: Date | null;
  expiresAt: Date;
}

describe('run 94 T1: reset token -> ticket cookie (real app)', () => {
  let full: FullApp;
  const lines: string[] = [];
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(...String(chunk).split('\n').filter(Boolean));
      cb();
    },
  });
  const secrets: string[] = [];
  let setup: Promise<void> | undefined;
  beforeAll(
    () =>
      (setup = (async () => {
        full = await bootFullApp({ name: 'run94-ticket', logStream });
      })()),
    INT_SETUP_TIMEOUT_MS,
  );
  afterAll(async () => {
    await settled(setup);
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);
  afterEach(() => jest.restoreAllMocks());

  const app = () => full.app;
  const tokens = () => full.app.get<Model<ResetDoc>>(getModelToken('PasswordResetToken'));
  const newUser = async () => {
    const email = `r94-${randomUUID()}@example.com`;
    const users = full.app.get(UserService);
    const user = await users.create({ email, password: GOOD });
    await users.verifyEmail(user.sub); // a verified account signs in with GOOD before the reset
    return email;
  };
  const mailedToken = async (email: string): Promise<string> => {
    const auth = full.app.get(AuthenticationService);
    await auth.forgotPassword(email);
    await auth.drainBackgroundWrites();
    const token = tokenFromMailLink(full.outbox.filter((m) => m.to === email).at(-1)!.text);
    secrets.push(token);
    return token;
  };
  const ticketOf = (jar: CookieJar): string | undefined => {
    const t = jar.values.get('idp_reset');
    if (t) secrets.push(t);
    return t;
  };
  const login = async (email: string, password: string) => {
    const form = await full.app.inject({ method: 'GET', url: '/login' });
    const jar = new CookieJar().take(form);
    const res = await full.app.inject({
      method: 'POST',
      url: '/login',
      headers: { cookie: jar.header() },
      payload: { _csrf: csrfOf(form), email, password },
    });
    return res.statusCode;
  };
  const resetCookieLine = (res: InjectResult) =>
    setCookiesOf(res).find((c) => c.startsWith('idp_reset='));
  const expectInvalid = (res: InjectResult) => {
    expect(res.statusCode).toBe(400);
    expect(resetCookieLine(res)?.startsWith('idp_reset=;') ?? true).toBe(true);
  };

  it('1: a valid token => 303 /reset, ticket cookie attributes, document holds the ticket hash', async () => {
    const email = await newUser();
    const token = await mailedToken(email);
    const jar = new CookieJar();
    const before = Date.now();
    const res = await exchangeResetToken(app(), token, jar);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/reset');
    const line = resetCookieLine(res)!;
    expect(line).toMatch(/^idp_reset=[A-Za-z0-9_-]{43};/);
    expect(line).toMatch(/; Max-Age=900(;|$)/);
    expect(line).toMatch(/; Path=\/(;|$)/);
    expect(line).toMatch(/; HttpOnly(;|$)/);
    expect(line).toMatch(/; SameSite=Lax(;|$)/);
    expect(line).not.toMatch(/; Domain=/i);
    const ticket = ticketOf(jar)!;
    const doc = (await tokens()
      .findOne({ tokenHash: sha256(token) })
      .lean())!;
    expect(doc.ticketHash).toBe(sha256(ticket));
    expect(doc.usedAt).toBeNull();
    expect(Math.abs(doc.expiresAt.getTime() - (before + TICKET_TTL_MS))).toBeLessThan(10_000);
  });

  it('2: exchanged / unknown / expired / used / malformed tokens get one identical 400 and no ticket', async () => {
    const email = await newUser();
    const exchanged = await mailedToken(email);
    expect((await exchangeResetToken(app(), exchanged)).statusCode).toBe(303);

    const expiredUser = await newUser();
    const expired = await mailedToken(expiredUser);
    await tokens().updateOne(
      { tokenHash: sha256(expired) },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const usedUser = await newUser();
    const used = await mailedToken(usedUser);
    await tokens().updateOne({ tokenHash: sha256(used) }, { $set: { usedAt: new Date() } });

    const cases = [
      exchanged, // replayed from another jar
      randomBytes(32).toString('base64url'), // unknown
      expired,
      used,
      'not-a-token<>',
    ];
    const answers: InjectResult[] = [];
    for (const t of cases) {
      const jar = new CookieJar();
      const res = await exchangeResetToken(app(), t, jar);
      expectInvalid(res);
      expect(jar.values.has('idp_reset')).toBe(false);
      answers.push(res);
    }
    for (const a of answers.slice(1)) expect(a.body).toBe(answers[0].body);
  });

  it('3: GET /reset shows the password form only with a live ticket; always no-store', async () => {
    const email = await newUser();
    const jar = new CookieJar();
    expect((await exchangeResetToken(app(), await mailedToken(email), jar)).statusCode).toBe(303);
    const withTicket = await app().inject({
      method: 'GET',
      url: '/reset',
      headers: { cookie: jar.header() },
    });
    expect(withTicket.statusCode).toBe(200);
    expect(withTicket.body).toContain('action="/reset"');
    expect(withTicket.body).toContain('name="password"');
    expect(withTicket.body).not.toContain('name="token"');
    expect(withTicket.headers['cache-control']).toBe('no-store');

    const codeForm = (res: InjectResult) => {
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('action="/reset/code"');
      expect(res.body).toMatch(/<input id="token" name="token" value="" required/);
      expect(res.body).toContain('id="token-manual"');
      expect(res.body).toContain('>Continue</button>');
      expect(res.body).toContain('<script src="/assets/token-fragment.js"></script></form>');
      expect(res.body).not.toContain('name="password"');
      expect(res.headers['cache-control']).toBe('no-store');
    };
    codeForm(await app().inject({ method: 'GET', url: '/reset' }));
    const bad = await app().inject({
      method: 'GET',
      url: '/reset',
      headers: { cookie: `idp_reset=${randomBytes(32).toString('base64url')}` },
    });
    codeForm(bad);
    expect(resetCookieLine(bad)).toMatch(/^idp_reset=;/); // dead ticket cookie is cleared

    await tokens().updateOne(
      { ticketHash: sha256(ticketOf(jar)!) },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    codeForm(
      await app().inject({ method: 'GET', url: '/reset', headers: { cookie: jar.header() } }),
    );
  });

  it('4: POST /reset with a live ticket changes the password, revokes sessions, clears the cookie; replay => 400', async () => {
    const email = await newUser();
    const user = (await full.app.get(UserService).findByEmail(email))!;
    const sessions = full.app.get(SessionService);
    const old = await sessions.establish(undefined, user.sub, DEFAULT_TENANT_ID, { amr: ['pwd'] });
    const jar = new CookieJar();
    await exchangeResetToken(app(), await mailedToken(email), jar);
    const ticket = ticketOf(jar)!;
    const ok = await postNewPassword(app(), NEW, jar);
    expect(ok.statusCode).toBe(201);
    expect(ok.body).toContain('Password changed');
    expect(resetCookieLine(ok)).toMatch(/^idp_reset=;/);
    expect((await sessions.listByUser(user.sub)).map((s) => s.ref)).not.toContain(old.session.ref);
    expect(await login(email, GOOD)).toBe(401);
    expect(await login(email, NEW)).toBe(303);

    // Replay the spent ticket itself (a fresh GET would already clear the dead cookie).
    const form = await app().inject({ method: 'GET', url: '/reset' });
    const csrfJar = new CookieJar().take(form);
    const replay = await app().inject({
      method: 'POST',
      url: '/reset',
      headers: { cookie: `${csrfJar.header()}; idp_reset=${ticket}` },
      payload: { _csrf: csrfOf(form), password: `${NEW}x` },
    });
    expectInvalid(replay);
    expect(await login(email, NEW)).toBe(303);
  });

  it('5: a password refused by the policy keeps the ticket; a good one then works', async () => {
    const email = await newUser();
    const jar = new CookieJar();
    await exchangeResetToken(app(), await mailedToken(email), jar);
    ticketOf(jar);
    const refused = await postNewPassword(app(), 'password', jar);
    expect(refused.statusCode).toBe(400);
    expect(resetCookieLine(refused)).toBeUndefined();
    expect((await postNewPassword(app(), NEW, jar)).statusCode).toBe(201);
    expect(await login(email, NEW)).toBe(303);
  });

  it('6: the old one-step body {_csrf, token, password} => 400; password unchanged; token still exchangeable', async () => {
    const email = await newUser();
    const token = await mailedToken(email);
    const form = await app().inject({ method: 'GET', url: '/reset' });
    const jar = new CookieJar().take(form);
    const res = await app().inject({
      method: 'POST',
      url: '/reset',
      headers: { cookie: jar.header() },
      payload: { _csrf: csrfOf(form), token, password: NEW },
    });
    expect(res.statusCode).toBe(400);
    expect(await login(email, GOOD)).toBe(303);
    expect((await exchangeResetToken(app(), token)).statusCode).toBe(303);
  });

  it('7: an expired ticket => 400 and the cookie is cleared', async () => {
    const email = await newUser();
    const jar = new CookieJar();
    await exchangeResetToken(app(), await mailedToken(email), jar);
    const ticket = ticketOf(jar)!;
    // Read the password form while the ticket is live, then expire it before the post.
    const form = await app().inject({
      method: 'GET',
      url: '/reset',
      headers: { cookie: jar.header() },
    });
    await tokens().updateOne(
      { ticketHash: sha256(ticket) },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const res = await app().inject({
      method: 'POST',
      url: '/reset',
      headers: { cookie: jar.header() },
      payload: { _csrf: csrfOf(form), password: NEW },
    });
    expectInvalid(res);
    expect(resetCookieLine(res)).toMatch(/^idp_reset=;/);
    expect(await login(email, GOOD)).toBe(303);
  });

  it('8: races: two exchanges of one token => one 303; two posts of one ticket => one success, one setPassword', async () => {
    const email = await newUser();
    const token = await mailedToken(email);
    const both = await Promise.all([
      exchangeResetToken(app(), token),
      exchangeResetToken(app(), token),
    ]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([303, 400]);

    const email2 = await newUser();
    const jar = new CookieJar();
    await exchangeResetToken(app(), await mailedToken(email2), jar);
    ticketOf(jar);
    const form = await app().inject({
      method: 'GET',
      url: '/reset',
      headers: { cookie: jar.header() },
    });
    const setPassword = jest.spyOn(full.app.get(UserService), 'setPassword');
    const post = () =>
      app().inject({
        method: 'POST',
        url: '/reset',
        headers: { cookie: jar.header() },
        payload: { _csrf: csrfOf(form), password: NEW },
      });
    const posts = await Promise.all([post(), post()]);
    expect(posts.map((r) => r.statusCode).sort()).toEqual([201, 400]);
    expect(setPassword).toHaveBeenCalledTimes(1);
  });

  it('9: a missing or wrong CSRF token on /reset/code => 403 and the token is untouched', async () => {
    const email = await newUser();
    const token = await mailedToken(email);
    const form = await app().inject({ method: 'GET', url: '/reset' });
    const jar = new CookieJar().take(form);
    for (const payload of [{ token }, { _csrf: 'forged', token }]) {
      const res = await app().inject({
        method: 'POST',
        url: '/reset/code',
        headers: { cookie: jar.header() },
        payload,
      });
      expect(res.statusCode).toBe(403);
      expect(resetCookieLine(res)).toBeUndefined();
    }
    const doc = (await tokens()
      .findOne({ tokenHash: sha256(token) })
      .lean())!;
    expect(doc.ticketHash ?? null).toBeNull();
    expect((await exchangeResetToken(app(), token)).statusCode).toBe(303);
  });

  it('10: a Mongo error while exchanging => 5xx, no ticket cookie', async () => {
    const email = await newUser();
    const token = await mailedToken(email);
    jest.spyOn(tokens(), 'findOneAndUpdate').mockImplementationOnce(() => {
      throw new Error('simulated mongo failure');
    });
    const res = await exchangeResetToken(app(), token);
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(resetCookieLine(res)).toBeUndefined();
  });

  it('12 (DEBT-685): a completed reset kills every other live reset token and ticket of the user', async () => {
    const email = await newUser();
    const mail1 = await mailedToken(email);
    const mail2 = await mailedToken(email);
    const mail3 = await mailedToken(email);
    // Mail 2 already exchanged in another browser (jar B): its ticket is live.
    const jarB = new CookieJar();
    expect((await exchangeResetToken(app(), mail2, jarB)).statusCode).toBe(303);
    ticketOf(jarB);
    // Reset with mail 1 (jar A).
    const jarA = new CookieJar();
    expect((await exchangeResetToken(app(), mail1, jarA)).statusCode).toBe(303);
    ticketOf(jarA);
    expect((await postNewPassword(app(), NEW, jarA)).statusCode).toBe(201);
    // Mail 3 (never exchanged) and ticket B are now dead; the new password stands.
    expectInvalid(await exchangeResetToken(app(), mail3));
    const form = await app().inject({
      method: 'GET',
      url: '/reset',
      headers: { cookie: jarB.header() },
    });
    expect(form.body).toContain('action="/reset/code"'); // ticket B no longer live
    const user = (await full.app.get(UserService).findByEmail(email))!;
    expect(await tokens().countDocuments({ userId: user.sub, usedAt: null })).toBe(0);
    expect(await login(email, NEW)).toBe(303);
  });

  it('12b (DEBT-685): a new mail opened while a ticket is live dies with the reset of that ticket', async () => {
    const email = await newUser();
    const jar = new CookieJar();
    expect((await exchangeResetToken(app(), await mailedToken(email), jar)).statusCode).toBe(303);
    ticketOf(jar);
    const later = await mailedToken(email);
    // Same browser opens the newer link: the live ticket shows the password form (the new token is not
    // exchanged), the reset completes, and the newer token is dead with it.
    expect((await postNewPassword(app(), NEW, jar)).statusCode).toBe(201);
    expectInvalid(await exchangeResetToken(app(), later));
  });

  it('13: the ticket never outlives the token (expiresAt = min(token expiry, now + 15 min))', async () => {
    const email = await newUser();
    const token = await mailedToken(email);
    const soon = new Date(Date.now() + 60_000);
    await tokens().updateOne({ tokenHash: sha256(token) }, { $set: { expiresAt: soon } });
    const jar = new CookieJar();
    expect((await exchangeResetToken(app(), token, jar)).statusCode).toBe(303);
    const doc = (await tokens()
      .findOne({ ticketHash: sha256(ticketOf(jar)!) })
      .lean())!;
    expect(doc.expiresAt.getTime()).toBe(soon.getTime());
  });

  it('index: {ticketHash: 1} is unique and partial on string values only (D94.4)', async () => {
    const idx = (await tokens().collection.indexes()).find((i) => i.key.ticketHash === 1)!;
    expect(idx.unique).toBe(true);
    expect(idx.partialFilterExpression).toEqual({ ticketHash: { $type: 'string' } });
  });

  it('11: no log line carries a mail token or a ticket', () => {
    expect(secrets.length).toBeGreaterThan(5);
    const all = lines.join('\n');
    for (const s of secrets) expect(all).not.toContain(s);
  });
});
