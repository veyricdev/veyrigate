import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { Types } from 'mongoose';
import { sha256 } from '../src/common/crypto/crypto.util';
import { RedisService } from '../src/database/redis/redis.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { UserService } from '../src/modules/identity/user.service';
import { base32Decode } from '../src/modules/mfa/base32';
import { MFA_KEYRING, type MfaKeyring } from '../src/modules/mfa/mfa-crypto';
import { MfaService } from '../src/modules/mfa/mfa.service';
import { totpAt, totpStep } from '../src/modules/mfa/totp';
import { ALERT_ACTIONS, AuditAction } from '../src/modules/security/audit/audit-action.enum';
import { RefreshTokenService } from '../src/modules/oauth/token/refresh-token.service';
import { SessionService } from '../src/modules/sessions/session.service';
import { CsrfService } from '../src/modules/ui/csrf.service';
import { bootFullApp, type FullApp, type InjectResponse } from './full-app';
import { enrollForTest } from './helpers/mfa';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';

/**
 * Run 89 T2 AC1–AC10 (D89.13, D89.18, D89.23, D89.24) on the REAL app: `/account/mfa` enroll /
 * turn off / new recovery codes, with re-authentication, CAS, revoke-all and no secret outside the
 * owner's no-store pages.
 */
const PASSWORD = 'r89a-Current#Pass-1';
const SEED = Buffer.from('r89-account-mfa-seed', 'ascii');
const WRONG = 'That code is not valid. Try again.';

const setCookies = (res: InjectResponse): string[] =>
  ([] as string[]).concat((res.headers['set-cookie'] as string | string[] | undefined) ?? []);
const pairOf = (res: InjectResponse, name: string) =>
  setCookies(res)
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0];
const csrfOf = (res: InjectResponse): string => res.body.match(/name="_csrf" value="([^"]+)"/)![1];
const keyOf = (res: InjectResponse) =>
  base32Decode(res.body.match(/<code>([A-Z2-7 ]+)<\/code>/)![1].replace(/ /g, ''));
const codesOf = (res: InjectResponse) =>
  [...res.body.matchAll(/<code>([0-9A-Z]{4}(?:-[0-9A-Z]{4}){3})<\/code>/g)].map((m) => m[1]);
const now = (secret: Buffer, offset = 0) => totpAt(secret, totpStep(Date.now()) + offset);

describe('run 89 T2: /account/mfa (real app)', () => {
  let full: FullApp;
  let redis: RedisService['client'];
  const logs: string[] = [];
  let setup: Promise<void> | undefined;
  beforeAll(
    () =>
      (setup = (async () => {
        full = await bootFullApp({
          name: 'run89-account-mfa',
          logStream: new Writable({
            write(chunk, _enc, cb) {
              logs.push(String(chunk));
              cb();
            },
          }),
        });
        redis = full.app.get(RedisService).client;
      })()),
    INT_SETUP_TIMEOUT_MS,
  );
  afterAll(async () => {
    await settled(setup);
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);
  afterEach(() => jest.restoreAllMocks());

  const newUser = async (withPassword = true) => {
    const email = `r89a-${randomUUID()}@fixture.test`;
    const users = full.app.get(UserService);
    const u = await users.create(
      withPassword ? { email, password: PASSWORD } : { email, emailVerifiedAt: new Date() },
    );
    if (withPassword) await users.verifyEmail(u.sub);
    await full.conn
      .model('UserTenant')
      .create({ userId: new Types.ObjectId(u.sub), tenantId: DEFAULT_TENANT_ID, status: 'active' });
    return { email, sub: u.sub };
  };
  /** A live session: real `/login` for a password account, else a direct `fed` session. */
  const signIn = async (u: { email: string; sub: string }, withPassword = true) => {
    if (!withPassword) {
      const s = await full.app
        .get(SessionService)
        .create(u.sub, DEFAULT_TENANT_ID, { amr: ['fed'] });
      return { id: s.id, ref: s.session.ref, jar: `idp_session=${s.id}` };
    }
    const page = (await full.app.inject({ method: 'GET', url: '/login' })) as InjectResponse;
    const res = (await full.app.inject({
      method: 'POST',
      url: '/login',
      remoteAddress: `203.0.113.${Math.floor(Math.random() * 250)}`,
      headers: { cookie: pairOf(page, 'idp_csrf')! },
      payload: { _csrf: csrfOf(page), email: u.email, password: PASSWORD, returnTo: '/' },
    })) as InjectResponse;
    const session = pairOf(res, 'idp_session')!;
    const id = session.split('=')[1];
    return { id, ref: sha256(id), jar: session };
  };
  type B = Awaited<ReturnType<typeof signIn>>;
  const page = (b?: B, query = '') =>
    full.app.inject({
      method: 'GET',
      url: `/account/mfa${query}`,
      headers: b ? { cookie: b.jar } : {},
    }) as Promise<InjectResponse>;
  const post = async (b: B, path: string, fields: Record<string, string> = {}, csrf?: string) => {
    const form = await page(b);
    return full.app.inject({
      method: 'POST',
      url: path,
      headers: { cookie: b.jar },
      payload: { _csrf: csrf ?? csrfOf(form), ...fields },
    }) as Promise<InjectResponse>;
  };
  const age = async (ref: string) => {
    const data = JSON.parse((await redis.get(`sess:${ref}`))!) as { authTime: number };
    data.authTime -= 301_000;
    await redis.set(`sess:${ref}`, JSON.stringify(data), 'KEEPTTL');
  };
  const audits = (sub: string, action: AuditAction) =>
    full.conn
      .model('AuditLog')
      .find({ action, actorId: sub })
      .lean<Array<Record<string, unknown>>>()
      .exec();
  const rawMfa = async (sub: string) =>
    (await full.conn.collection('users').findOne({ _id: new Types.ObjectId(sub) }))?.mfa;
  const mailsTo = (email: string) => full.outbox.filter((m) => m.to === email);
  /** Enroll through the pages; returns the seed, the codes page and the step used. */
  const enroll = async (b: B) => {
    const setupPage = await post(b, '/account/mfa/start');
    const seed = keyOf(setupPage);
    const step = totpStep(Date.now());
    const done = await post(b, '/account/mfa/confirm', { code: totpAt(seed, step) });
    return { setupPage, seed, step, done };
  };

  it('AC1 no session => 302 /login?returnTo=%2Faccount%2Fmfa (a strange returnTo dropped); with a session => off', async () => {
    const anon = await page();
    expect(anon.statusCode).toBe(302);
    expect(anon.headers['location']).toBe('/login?returnTo=%2Faccount%2Fmfa');
    const evil = await page(undefined, '?returnTo=https%3A%2F%2Fevil.example%2F');
    expect(evil.headers['location']).toBe('/login?returnTo=%2Faccount%2Fmfa');
    const kept = await page(undefined, '?returnTo=%2Fauthorize%3Frequest_id%3Dabc');
    expect(kept.headers['location']).toBe(
      `/login?returnTo=${encodeURIComponent('/account/mfa?returnTo=%2Fauthorize%3Frequest_id%3Dabc')}`,
    );
    const u = await newUser();
    const res = await page(await signIn(u));
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('Two-step verification is off');
    expect(res.body).toContain('action="/account/mfa/start"');
  });

  it('AC2 start => sealed pending secret at mfa_enr:{sessionRef} (TTL 600), key grouped by 4, otpauth link, no-store', async () => {
    const u = await newUser();
    const b = await signIn(u);
    const res = await post(b, '/account/mfa/start');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const key = res.body.match(/<code>([A-Z2-7 ]+)<\/code>/)![1];
    expect(key).toMatch(/^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/);
    const plain = key.replace(/ /g, '');
    expect(res.body).toContain(
      `otpauth://totp/${encodeURIComponent(`Veyrigate:${u.email}`)}?secret=${plain}&amp;issuer=Veyrigate&amp;algorithm=SHA1&amp;digits=6&amp;period=30`,
    );
    const pending = await redis.get(`mfa_enr:${b.ref}`);
    expect(pending).not.toContain(plain);
    expect(JSON.parse(pending!)).toMatchObject({ kid: 'k1' });
    expect(await redis.pttl(`mfa_enr:${b.ref}`)).toBeGreaterThan(590_000);
    expect(await redis.exists(`mfa_enr:${u.sub}`)).toBe(0);
  });

  it('AC3 confirm: wrong => 400, pending kept; right => enrolled (lastStep), pending gone, 10 codes once, every session revoked, cookie cleared, mail, audit', async () => {
    const u = await newUser();
    const b = await signIn(u);
    const other = await signIn(u);
    const setupPage = await post(b, '/account/mfa/start', { returnTo: '/authorize?request_id=r1' });
    const seed = keyOf(setupPage);
    const wrong = await post(b, '/account/mfa/confirm', { code: '000000' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.body).toContain(WRONG);
    expect(await redis.exists(`mfa_enr:${b.ref}`)).toBe(1);

    const step = totpStep(Date.now());
    const done = await post(b, '/account/mfa/confirm', {
      code: totpAt(seed, step),
      returnTo: '/authorize?request_id=r1',
    });
    expect(done.statusCode).toBe(200);
    expect(done.headers['cache-control']).toBe('no-store');
    expect(codesOf(done)).toHaveLength(10);
    expect(done.body).toContain(
      `href="/login?returnTo=${encodeURIComponent('/authorize?request_id=r1')}"`,
    );
    expect(setCookies(done).some((c) => /^idp_session=;/.test(c))).toBe(true);
    expect(await rawMfa(u.sub)).toMatchObject({ lastStep: step });
    expect(await redis.exists(`mfa_enr:${b.ref}`)).toBe(0);
    expect(await redis.exists(`sess:${b.ref}`)).toBe(0);
    expect(await redis.exists(`sess:${other.ref}`)).toBe(0);
    expect(await redis.exists(`sess_end:${other.ref}`)).toBe(1);
    expect(mailsTo(u.email).map((m) => m.subject)).toEqual(['Two-step verification was turned on']);
    expect(await audits(u.sub, AuditAction.MFA_ENROLLED)).toHaveLength(1);
    // Shown once: the page is gone with the session.
    expect((await page(b)).statusCode).toBe(302);
  });

  it('AC3 expired / missing pending secret => 400 "start again"; another session of the same user does not see it', async () => {
    const u = await newUser();
    const a = await signIn(u);
    const b2 = await signIn(u);
    const setupPage = await post(a, '/account/mfa/start');
    const seed = keyOf(setupPage);
    const foreign = await post(b2, '/account/mfa/confirm', { code: now(seed) });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.body).toContain('The setup expired. Start again.');
    expect(await rawMfa(u.sub)).toBeUndefined();
    await redis.del(`mfa_enr:${a.ref}`);
    expect((await post(a, '/account/mfa/confirm', { code: now(seed) })).statusCode).toBe(400);
  });

  it('AC4 the code used to enroll cannot sign in (same step)', async () => {
    const u = await newUser();
    const { seed, step } = await enroll(await signIn(u));
    const page1 = (await full.app.inject({ method: 'GET', url: '/login' })) as InjectResponse;
    const s1 = (await full.app.inject({
      method: 'POST',
      url: '/login',
      headers: { cookie: pairOf(page1, 'idp_csrf')! },
      payload: { _csrf: csrfOf(page1), email: u.email, password: PASSWORD },
    })) as InjectResponse;
    const ticket = pairOf(s1, 'idp_mfa')!;
    const form = (await full.app.inject({
      method: 'GET',
      url: '/login/mfa',
      headers: { cookie: ticket },
    })) as InjectResponse;
    const res = await full.app.inject({
      method: 'POST',
      url: '/login/mfa',
      headers: { cookie: ticket },
      payload: { _csrf: csrfOf(form), code: totpAt(seed, step) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('AC5 two concurrent confirms (same session, same code) => one enrollment, one revoke-all, one mail', async () => {
    const u = await newUser();
    const b = await signIn(u);
    const seed = keyOf(await post(b, '/account/mfa/start'));
    const form = await page(b);
    const send = () =>
      full.app.inject({
        method: 'POST',
        url: '/account/mfa/confirm',
        headers: { cookie: b.jar },
        payload: { _csrf: csrfOf(form), code: now(seed) },
      }) as Promise<InjectResponse>;
    const both = await Promise.all([send(), send()]);
    expect(both.filter((r) => codesOf(r).length === 10)).toHaveLength(1);
    expect(await audits(u.sub, AuditAction.MFA_ENROLLED)).toHaveLength(1);
    expect(mailsTo(u.email)).toHaveLength(1);
  });

  it('AC6 disable: no password / wrong password / wrong TOTP / malformed or unknown recovery code => 400, still on; both right => off, revoke-all, mail, MFA_DISABLED', async () => {
    const u = await newUser();
    const seed = SEED;
    const { codes } = await enrollForTest(
      full.conn,
      full.app.get<MfaKeyring>(MFA_KEYRING),
      u.sub,
      seed,
    );
    // Step 2 with c-1, so the disable below can use c (a step is accepted once).
    const b = await mfaSignIn(u.email, seed, -1);
    const tries: Record<string, string>[] = [
      { code: now(seed, 0) },
      { current_password: 'wrong-password-1', code: now(seed, 0) },
      { current_password: PASSWORD, code: '000000' },
      { current_password: PASSWORD, code: 'AAAA-BBBB-CCCC-DDDD' },
      { current_password: PASSWORD, code: '' },
    ];
    expect(codes).toHaveLength(10);
    for (const fields of tries) {
      const r = await post(b, '/account/mfa/disable', fields);
      expect(r.statusCode).toBe(400);
      expect(await rawMfa(u.sub)).toBeDefined();
    }
    const off = await post(b, '/account/mfa/disable', {
      current_password: PASSWORD,
      code: now(seed, 0),
    });
    expect(off.statusCode).toBe(200);
    expect(await rawMfa(u.sub)).toBeUndefined();
    expect(await redis.exists(`sess:${b.ref}`)).toBe(0);
    expect(mailsTo(u.email).map((m) => m.subject)).toContain(
      'Two-step verification was turned off',
    );
    // DEBT-639: the refused re-authentication is NOT recorded under the alerting MFA_DISABLED.
    const disabled = await audits(u.sub, AuditAction.MFA_DISABLED);
    expect(disabled.map((e) => e.result)).toEqual(['success']);
    // DEBT-638: the shared re-authentication audits with the request context.
    const reauth = await audits(u.sub, AuditAction.AUTH_REAUTH_FAILED);
    expect(reauth).toHaveLength(1);
    expect(reauth[0]).toMatchObject({
      result: 'failure',
      reason: 'reauth_failed',
      metadata: { scope: 'mfa_disable', via: 'self' },
      ip: expect.any(String),
      requestId: expect.any(String),
      userAgent: expect.any(String),
    });
    expect(ALERT_ACTIONS.has(AuditAction.AUTH_REAUTH_FAILED)).toBe(false);
  });

  it('D89.27 lost authenticator: password + a RECOVERY code regenerates codes and turns MFA off; the code is consumed, a used one is refused, factor recorded', async () => {
    const u = await newUser();
    const { codes } = await enrollForTest(
      full.conn,
      full.app.get<MfaKeyring>(MFA_KEYRING),
      u.sub,
      SEED,
    );
    const b = await mfaSignIn(u.email, SEED, 0);
    await full.conn
      .collection('users')
      .updateOne({ _id: new Types.ObjectId(u.sub) }, { $set: { 'mfa.failures': 7 } });
    const regen = await post(b, '/account/mfa/recovery', {
      current_password: PASSWORD,
      code: codes[1],
    });
    expect(regen.statusCode).toBe(200);
    const fresh = codesOf(regen);
    expect(fresh).toHaveLength(10);
    expect((await rawMfa(u.sub)).failures).toBeUndefined();
    expect((await audits(u.sub, AuditAction.MFA_RECOVERY_REGENERATED))[0]).toMatchObject({
      metadata: { factor: 'recovery_code' },
    });
    // The old code was spent (and every old code died with the regeneration).
    const reused = await post(b, '/account/mfa/disable', {
      current_password: PASSWORD,
      code: codes[1],
    });
    expect(reused.statusCode).toBe(400);
    expect(await rawMfa(u.sub)).toBeDefined();
    const off = await post(b, '/account/mfa/disable', {
      current_password: PASSWORD,
      code: fresh[0],
    });
    expect(off.statusCode).toBe(200);
    expect(await rawMfa(u.sub)).toBeUndefined();
    expect((await audits(u.sub, AuditAction.MFA_DISABLED))[0]).toMatchObject({
      result: 'success',
      metadata: { factor: 'recovery_code' },
    });
    const used = await audits(u.sub, AuditAction.MFA_RECOVERY_USED);
    expect(used.map((e) => (e.metadata as { via: string }).via)).toEqual(['account', 'account']);
  });

  it('AC6 federation-only account: fresh session + TOTP => off; stale session => 400 guidance', async () => {
    const u = await newUser(false);
    await enrollForTest(full.conn, full.app.get<MfaKeyring>(MFA_KEYRING), u.sub, SEED);
    const stale = await signIn(u, false);
    await age(stale.ref);
    // The stale page has no form (nothing to submit): post with a token bound to that session.
    const refused = await post(
      stale,
      '/account/mfa/disable',
      { code: now(SEED) },
      full.app.get(CsrfService).token(stale.id),
    );
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain('sign out and sign in again');
    const fresh = await signIn(u, false);
    const ok = await post(fresh, '/account/mfa/disable', { code: now(SEED) });
    expect(ok.statusCode).toBe(200);
    expect(await rawMfa(u.sub)).toBeUndefined();
  });

  it('AC7 new recovery codes: password + TOTP => 10 new, old dead, new valid, mail, audit, session kept', async () => {
    const u = await newUser();
    const keyring = full.app.get<MfaKeyring>(MFA_KEYRING);
    const { codes: old } = await enrollForTest(full.conn, keyring, u.sub, SEED);
    const b = await mfaSignIn(u.email, SEED, -1);
    const res = await post(b, '/account/mfa/recovery', {
      current_password: PASSWORD,
      code: now(SEED),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const fresh = codesOf(res);
    expect(fresh).toHaveLength(10);
    const mfa = full.app.get(MfaService);
    expect(await mfa.consumeRecovery(u.sub, old[1])).toEqual({ ok: false });
    expect(await mfa.consumeRecovery(u.sub, fresh[0])).toMatchObject({ ok: true });
    expect(await redis.exists(`sess:${b.ref}`)).toBe(1);
    expect(mailsTo(u.email).map((m) => m.subject)).toContain('New recovery codes were created');
    expect(await audits(u.sub, AuditAction.MFA_RECOVERY_REGENERATED)).toHaveLength(1);
  });

  it('DEBT-641 revoke-all fails after enroll / after disable => 5xx, revoke_failed audit with failedStep, the new MFA state is kept', async () => {
    const refresh = full.app.get(RefreshTokenService);
    const u = await newUser();
    const b = await signIn(u);
    const seed = keyOf(await post(b, '/account/mfa/start'));
    const step = totpStep(Date.now());
    jest.spyOn(refresh, 'revokeAllForUser').mockRejectedValueOnce(new Error('mongo down'));
    const enrolled = await post(b, '/account/mfa/confirm', { code: totpAt(seed, step - 1) });
    expect(enrolled.statusCode).toBeGreaterThanOrEqual(500);
    expect(await rawMfa(u.sub)).toMatchObject({ lastStep: step - 1 });
    expect(
      (await audits(u.sub, AuditAction.MFA_ENROLLED)).map((e) => e.reason ?? e.result),
    ).toEqual(['success', 'revoke_failed']);
    expect(
      (await audits(u.sub, AuditAction.MFA_ENROLLED)).find((e) => e.reason === 'revoke_failed'),
    ).toMatchObject({ metadata: { failedStep: 'pre_revoke' } });

    const b2 = await mfaSignIn(u.email, seed, 0);
    jest.spyOn(refresh, 'revokeAllForUser').mockRejectedValueOnce(new Error('mongo down'));
    const off = await post(b2, '/account/mfa/disable', {
      current_password: PASSWORD,
      code: now(seed, 1),
    });
    expect(off.statusCode).toBeGreaterThanOrEqual(500);
    expect(await rawMfa(u.sub)).toBeUndefined();
    const disabled = await audits(u.sub, AuditAction.MFA_DISABLED);
    expect(disabled.map((e) => e.reason ?? e.result)).toEqual(['success', 'revoke_failed']);
  });

  it('AC8 every POST without _csrf or with a token of another identity => 403, nothing changes', async () => {
    const u = await newUser();
    const b = await signIn(u);
    const foreign = csrfOf(
      (await full.app.inject({ method: 'GET', url: '/login' })) as InjectResponse,
    );
    for (const path of ['start', 'confirm', 'disable', 'recovery']) {
      for (const csrf of ['', foreign]) {
        const r = await full.app.inject({
          method: 'POST',
          url: `/account/mfa/${path}`,
          headers: { cookie: b.jar },
          payload: { _csrf: csrf, code: '123456', current_password: PASSWORD },
        });
        expect(r.statusCode).toBe(403);
      }
    }
    expect(await redis.exists(`mfa_enr:${b.ref}`)).toBe(0);
    expect(await rawMfa(u.sub)).toBeUndefined();
  });

  it('AC9 no secret, otpauth, recovery code or ciphertext in logs, audits or mails', async () => {
    const u = await newUser();
    const before = logs.length;
    const { setupPage, done } = await enroll(await signIn(u));
    const plain = setupPage.body.match(/<code>([A-Z2-7 ]+)<\/code>/)![1].replace(/ /g, '');
    const codes = codesOf(done).map((c) => c.replace(/-/g, ''));
    const ct = (await rawMfa(u.sub)).secret.ct as string;
    const haystacks = [
      logs.slice(before).join('\n'),
      JSON.stringify(await full.conn.model('AuditLog').find({ actorId: u.sub }).lean().exec()),
      JSON.stringify(mailsTo(u.email)),
    ];
    for (const h of haystacks) {
      for (const leak of [plain, 'otpauth', ct, ...codes, ...codesOf(done)]) {
        expect(h).not.toContain(leak);
      }
    }
  });

  it('AC10 /account/sessions shows "+ authenticator" for a session through step 2; / links /account/mfa', async () => {
    const u = await newUser();
    await enrollForTest(full.conn, full.app.get<MfaKeyring>(MFA_KEYRING), u.sub, SEED);
    const b = await mfaSignIn(u.email, SEED, 0);
    const sessions = await full.app.inject({
      method: 'GET',
      url: '/account/sessions',
      headers: { cookie: b.jar },
    });
    expect(sessions.body).toContain('Password + authenticator');
    const home = await full.app.inject({ method: 'GET', url: '/', headers: { cookie: b.jar } });
    expect(home.body).toContain('href="/account/mfa"');
  });

  /** `/login` + `/login/mfa` with the code of step `c + offset`. */
  async function mfaSignIn(email: string, seed: Buffer, offset: number): Promise<B> {
    const p = (await full.app.inject({ method: 'GET', url: '/login' })) as InjectResponse;
    const s1 = (await full.app.inject({
      method: 'POST',
      url: '/login',
      remoteAddress: `192.0.2.${Math.floor(Math.random() * 250)}`,
      headers: { cookie: pairOf(p, 'idp_csrf')! },
      payload: { _csrf: csrfOf(p), email, password: PASSWORD },
    })) as InjectResponse;
    const ticket = pairOf(s1, 'idp_mfa')!;
    const form = (await full.app.inject({
      method: 'GET',
      url: '/login/mfa',
      headers: { cookie: ticket },
    })) as InjectResponse;
    const res = (await full.app.inject({
      method: 'POST',
      url: '/login/mfa',
      headers: { cookie: ticket },
      payload: { _csrf: csrfOf(form), code: now(seed, offset) },
    })) as InjectResponse;
    const session = pairOf(res, 'idp_session')!;
    const id = session.split('=')[1];
    return { id, ref: sha256(id), jar: session };
  }
});
