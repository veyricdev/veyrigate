import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import type { Model } from 'mongoose';
import { MfaKeyring, parseMfaKeys, totpAad } from './mfa-crypto';
import { MFA_FAILURE_CAP, MfaService } from './mfa.service';
import { hashRecoveryCode } from './recovery-codes';
import { totpAt, totpStep } from './totp';

/** Run 89 T1 AC7: the CAS filters `MfaService` writes (Mongo mocked; the int spec runs them for real). */
const USER = '65f0000000000000000000aa';
const NOW = 1_800_000_000_000;
const C = totpStep(NOW);
const k = (b: number) => Buffer.alloc(32, b).toString('base64');
const SECRET = Buffer.from('0123456789abcdef0123', 'ascii');

function harness(keys: string, mfa: Record<string, unknown> | null, modified = 1) {
  const ring = new MfaKeyring(parseMfaKeys(keys));
  const updates: { filter: Record<string, unknown>; update: Record<string, unknown> }[] = [];
  const chain = (value: unknown) => ({
    select: () => chain(value),
    lean: () => chain(value),
    exec: async () => value,
  });
  const users = {
    findById: () => chain(mfa ? { _id: USER, mfa } : { _id: USER }),
    updateOne: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      updates.push({ filter, update });
      return { modifiedCount: modified };
    },
    findOneAndUpdate: (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      updates.push({ filter, update });
      return chain(modified ? { mfa: { recovery: [{ hash: 'x' }] } } : null);
    },
  } as unknown as Model<never>;
  return { svc: new MfaService(users as never, ring), ring, updates };
}

describe('MfaService CAS filters (AC7)', () => {
  beforeAll(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterAll(() => {
    jest.restoreAllMocks();
  });
  const enrolledAt = new Date(NOW - 60_000);
  const stored = (ring: MfaKeyring, lastStep?: number) => ({
    secret: ring.seal(SECRET, totpAad(USER)),
    enrolledAt,
    ...(lastStep !== undefined ? { lastStep } : {}),
    recoverySalt: 'ab'.repeat(16),
    recovery: [{ hash: hashRecoveryCode('ab'.repeat(16), 'ABCDEFGHJKMNPQRS') }],
  });

  it('enroll: CAS on "no mfa yet", lastStep = the confirming step, sealed seed, hashed codes only', async () => {
    const { svc, updates } = harness(`k1:${k(1)}`, null);
    const r = await svc.enroll(USER, SECRET, C, ['ABCD-EFGH-JKMN-PQRS']);
    expect(r).toEqual({ ok: true, enrolledAt: new Date(NOW) });
    expect(updates[0].filter).toEqual({ _id: USER, mfa: { $exists: false } });
    const set = (updates[0].update.$set as { mfa: Record<string, unknown> }).mfa;
    expect(set).toMatchObject({ enrolledAt: new Date(NOW), lastStep: C });
    expect(JSON.stringify(set)).not.toContain('ABCDEFGHJKMNPQRS');
    expect(JSON.stringify(set)).not.toContain(SECRET.toString('base64'));
  });

  it('enroll lost the CAS => not ok (already enrolled)', async () => {
    const { svc } = harness(`k1:${k(1)}`, null, 0);
    expect(await svc.enroll(USER, SECRET, C, [])).toEqual({ ok: false });
  });

  it('verify: right code => CAS on enrolledAt AND lastStep < step (or absent), $set lastStep only', async () => {
    const h = harness(`k1:${k(1)}`, null);
    const { svc, updates } = harness(`k1:${k(1)}`, stored(h.ring, C - 1));
    // Same key material, so the harness ring opens what `h.ring` sealed.
    const r = await svc.verify(USER, totpAt(SECRET, C), enrolledAt);
    expect(r).toEqual({ ok: true, enrolledAt, step: C });
    expect(updates[0].filter).toEqual({
      _id: USER,
      'mfa.enrolledAt': enrolledAt,
      // nit 1: the cap is part of the CAS (exact under concurrency).
      'mfa.failures': { $not: { $gte: MFA_FAILURE_CAP } },
      $or: [{ 'mfa.lastStep': { $lt: C } }, { 'mfa.lastStep': { $exists: false } }],
    });
    // DEBT-640: a right code also ends the consecutive-failure run.
    expect(updates[0].update).toEqual({
      $set: { 'mfa.lastStep': C },
      $unset: { 'mfa.failures': 1 },
    });
  });

  it('verify: CAS lost (another instance took the step) => not ok', async () => {
    const h = harness(`k1:${k(1)}`, null);
    const { svc } = harness(`k1:${k(1)}`, stored(h.ring), 0);
    expect(await svc.verify(USER, totpAt(SECRET, C))).toEqual({ ok: false });
  });

  it('verify: other enrollment, wrong code, used step => not ok, nothing written', async () => {
    const h = harness(`k1:${k(1)}`, null);
    const { svc, updates } = harness(`k1:${k(1)}`, stored(h.ring, C));
    expect(await svc.verify(USER, totpAt(SECRET, C + 1), new Date(NOW))).toEqual({ ok: false });
    expect(await svc.verify(USER, '000000')).toEqual({ ok: false });
    expect(await svc.verify(USER, totpAt(SECRET, C))).toEqual({ ok: false });
    expect(updates).toEqual([]);
  });

  it('verify under an older kid => the same update re-seals with the current kid', async () => {
    const old = harness(`k1:${k(1)}`, null);
    const { svc, updates, ring } = harness(`k2:${k(2)},k1:${k(1)}`, stored(old.ring));
    await svc.verify(USER, totpAt(SECRET, C));
    const set = updates[0].update.$set as Record<string, unknown>;
    expect(set['mfa.lastStep']).toBe(C);
    const resealed = set['mfa.secret'] as ReturnType<MfaKeyring['seal']>;
    expect(resealed.kid).toBe('k2');
    expect(ring.open(resealed, totpAad(USER))?.equals(SECRET)).toBe(true);
  });

  it('consumeRecovery: normalizes, $pull of the hash is the CAS (enrolledAt + hash in the filter)', async () => {
    const h = harness(`k1:${k(1)}`, null);
    const { svc, updates } = harness(`k1:${k(1)}`, stored(h.ring));
    const r = await svc.consumeRecovery(USER, 'abcd efgh-jkmn pqrs');
    expect(r).toEqual({ ok: true, enrolledAt, recoveryLeft: 1 });
    const hash = hashRecoveryCode('ab'.repeat(16), 'ABCDEFGHJKMNPQRS');
    expect(updates[0]).toEqual({
      filter: { _id: USER, 'mfa.enrolledAt': enrolledAt, 'mfa.recovery.hash': hash },
      update: { $pull: { 'mfa.recovery': { hash } }, $unset: { 'mfa.failures': 1 } },
    });
  });

  it('regenerate / disable: CAS on enrolledAt', async () => {
    const { svc, updates } = harness(`k1:${k(1)}`, null);
    expect(await svc.regenerate(USER, enrolledAt, ['ABCD-EFGH-JKMN-PQRS'])).toBe(true);
    expect(await svc.disable(USER, enrolledAt)).toBe(true);
    expect(updates[0].filter).toEqual({ _id: USER, 'mfa.enrolledAt': enrolledAt });
    expect(updates[1]).toEqual({
      filter: { _id: USER, 'mfa.enrolledAt': enrolledAt },
      update: { $unset: { mfa: 1 } },
    });
  });

  it('DEBT-640 cap reached: even the right TOTP is refused as suspended, nothing written; a recovery code still works', async () => {
    const h = harness(`k1:${k(1)}`, null);
    const capped = { ...stored(h.ring), failures: MFA_FAILURE_CAP };
    const { svc, updates } = harness(`k1:${k(1)}`, capped);
    expect(await svc.verify(USER, totpAt(SECRET, C))).toEqual({ ok: false, suspended: true });
    expect(updates).toEqual([]);
    expect(await svc.consumeRecovery(USER, 'ABCD-EFGH-JKMN-PQRS')).toMatchObject({ ok: true });
  });

  it('DEBT-640 recordFailure: $inc on an enrolled user, returns the new count', async () => {
    const { svc, updates } = harness(`k1:${k(1)}`, null);
    expect(MFA_FAILURE_CAP).toBeLessThanOrEqual(100);
    await svc.recordFailure(USER);
    expect(updates[0]).toEqual({
      filter: { _id: USER, mfa: { $exists: true } },
      update: { $inc: { 'mfa.failures': 1 } },
    });
  });
});
