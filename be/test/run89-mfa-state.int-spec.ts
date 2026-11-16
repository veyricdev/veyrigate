import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { toAdminUser } from '../src/modules/admin/admin.mappers';
import { UserService } from '../src/modules/identity/user.service';
import { MFA_KEYRING, type MfaKeyring, totpAad } from '../src/modules/mfa/mfa-crypto';
import { MfaService } from '../src/modules/mfa/mfa.service';
import { totpAt, totpStep } from '../src/modules/mfa/totp';
import { bootFullApp, type FullApp } from './full-app';
import { enrollForTest, TEST_MFA_ENCRYPTION_KEYS, testKeyring } from './helpers/mfa';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';

/**
 * Run 89 T1 on real Mongo: `User.mfa` never leaves through the user reads (AC6), one TOTP step and
 * one recovery code are accepted at most once under concurrency (AC8), and a seed sealed under an
 * older kid is re-sealed with the current one on a right code only (AC10).
 */
const SECRET = Buffer.from('r89-mfa-state-seed!!', 'ascii');

describe('run 89 T1: MFA state (real Mongo)', () => {
  let full: FullApp;
  let mfa: MfaService;
  let keyring: MfaKeyring;
  let setup: Promise<void> | undefined;
  beforeAll(
    () =>
      (setup = (async () => {
        full = await bootFullApp({ name: 'run89-mfa-state' });
        mfa = full.app.get(MfaService);
        keyring = full.app.get<MfaKeyring>(MFA_KEYRING);
      })()),
    INT_SETUP_TIMEOUT_MS,
  );
  afterAll(async () => {
    await settled(setup);
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);

  const newUser = async () => {
    const email = `r89m-${randomUUID()}@fixture.test`;
    const u = await full.app.get(UserService).create({ email, password: 'r89m-Pass#word-1' });
    return { email, sub: u.sub };
  };
  const raw = (sub: string) =>
    full.conn.collection('users').findOne({ _id: new Types.ObjectId(sub) });

  it('AC6 an enrolled user: no read path returns mfa (ct, recovery, recoverySalt)', async () => {
    const u = await newUser();
    await enrollForTest(full.conn, keyring, u.sub, SECRET);
    const doc = await raw(u.sub);
    expect(doc?.mfa?.secret?.ct).toEqual(expect.any(String));
    const users = full.app.get(UserService);
    const reads = [
      await users.findById(u.sub),
      await users.findByEmail(u.email),
      await users.findByIds([u.sub]),
      await users.findByEmailForAuthentication(u.email),
      await users.findByIdForAuthentication(u.sub),
    ];
    for (const r of reads) {
      const json = JSON.stringify(r);
      expect(json).toContain(u.sub);
      for (const leak of ['"mfa"', 'recoverySalt', 'recovery', doc!.mfa.secret.ct, '"ct"']) {
        expect(json).not.toContain(leak);
      }
    }
    // T4 AC4: the admin view shows only {enrolled, enrolledAt}.
    const admin = JSON.stringify(
      toAdminUser(
        (await users.findById(u.sub))!,
        { status: 'active', roles: [] },
        new Date(),
        await users.mfaEnrolledAt(u.sub),
      ),
    );
    expect(admin).toContain('"mfa":{"enrolled":true,"enrolledAt":');
    for (const leak of ['recoverySalt', 'recovery', doc!.mfa.secret.ct, '"ct"', '"secret"']) {
      expect(admin).not.toContain(leak);
    }
  });

  it('AC8 20 concurrent verify with the same code => exactly one accepted; an older step after a newer one => refused', async () => {
    const u = await newUser();
    await enrollForTest(full.conn, keyring, u.sub, SECRET);
    const c = totpStep(Date.now());
    const code = totpAt(SECRET, c);
    const results = await Promise.all(Array.from({ length: 20 }, () => mfa.verify(u.sub, code)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await raw(u.sub))?.mfa.lastStep).toBe(c);

    // c+1 accepted, then c (older) refused even though it is inside the window.
    const u2 = await newUser();
    await enrollForTest(full.conn, keyring, u2.sub, SECRET);
    expect(await mfa.verify(u2.sub, totpAt(SECRET, c + 1))).toMatchObject({
      ok: true,
      step: c + 1,
    });
    expect(await mfa.verify(u2.sub, totpAt(SECRET, c))).toEqual({ ok: false });
    expect(await mfa.verify(u2.sub, totpAt(SECRET, c + 1))).toEqual({ ok: false });
  });

  it('AC8 10 concurrent consumeRecovery with the same code => exactly one; reuse refused; others still work', async () => {
    const u = await newUser();
    const { codes } = await enrollForTest(full.conn, keyring, u.sub, SECRET);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => mfa.consumeRecovery(u.sub, codes[0].toLowerCase())),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => r.ok)).toMatchObject({ recoveryLeft: 9 });
    expect(await mfa.consumeRecovery(u.sub, codes[0])).toEqual({ ok: false });
    expect(await mfa.consumeRecovery(u.sub, codes[1])).toMatchObject({ ok: true, recoveryLeft: 8 });
    const stored = await raw(u.sub);
    expect(JSON.stringify(stored?.mfa)).not.toContain(codes[2].replace(/-/g, ''));
  });

  it('enroll: second enrollment loses the CAS; state reports enrolledAt + codes left; disable needs the same enrolledAt', async () => {
    const u = await newUser();
    const step = totpStep(Date.now());
    const first = await mfa.enroll(u.sub, SECRET, step, ['ABCD-EFGH-JKMN-PQRS']);
    expect(first.ok).toBe(true);
    expect(await mfa.enroll(u.sub, SECRET, step, [])).toEqual({ ok: false });
    const state = await mfa.state(u.sub);
    expect(state).toMatchObject({ enrolled: true, recoveryLeft: 1 });
    const users = full.app.get(UserService);
    expect(await users.mfaEnrolledAt(u.sub)).toEqual((state as { enrolledAt: Date }).enrolledAt);
    // The confirming code itself can never be accepted again (lastStep = its step).
    expect(await mfa.verify(u.sub, totpAt(SECRET, step))).toEqual({ ok: false });
    expect(await mfa.disable(u.sub, new Date(0))).toBe(false);
    expect(await mfa.disable(u.sub, (state as { enrolledAt: Date }).enrolledAt)).toBe(true);
    expect(await mfa.state(u.sub)).toEqual({ enrolled: false });
    expect(await users.mfaEnrolledAt(u.sub)).toBeNull();
  });

  it('AC10 keyring [k2,k1], seed under k1: right code => stored kid k2 and opens with k2; wrong code => kid unchanged', async () => {
    const k2 = `k2:${Buffer.alloc(32, 9).toString('base64')}`;
    const rotated = testKeyring(`${k2},${TEST_MFA_ENCRYPTION_KEYS}`);
    const svc = new MfaService(full.conn.model('User') as never, rotated);
    const u = await newUser();
    await enrollForTest(full.conn, testKeyring(), u.sub, SECRET);

    expect(await svc.verify(u.sub, '000000')).toEqual({ ok: false });
    expect((await raw(u.sub))?.mfa.secret.kid).toBe('k1');

    const ok = await svc.verify(u.sub, totpAt(SECRET, totpStep(Date.now())));
    expect(ok.ok).toBe(true);
    const sealed = (await raw(u.sub))?.mfa.secret;
    expect(sealed.kid).toBe('k2');
    expect(testKeyring(k2).open(sealed, totpAad(u.sub))?.equals(SECRET)).toBe(true);
  });
});
