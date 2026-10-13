import { jest } from '@jest/globals';
import { Types } from 'mongoose';
import { ConsentService, type Consent, type ConsentVersions } from './consent.service';

/**
 * DEBT-060: grant retries the upsert EXACTLY ONCE on a transient MongoDB `E11000` (duplicate key
 * from a concurrent upsert race) and propagates everything else unchanged. Pure mock-level unit
 * test — no race/int needed (tech-lead fold).
 */
describe('ConsentService.grant (DEBT-060 retry-once on E11000)', () => {
  const USER = new Types.ObjectId().toHexString();
  const CLIENT = 'rp-client';
  const VERSIONS: ConsentVersions = { policyVersion: 'p1', termsVersion: 't1' };

  const makeDoc = (): Consent => ({
    userId: new Types.ObjectId(USER),
    clientId: CLIENT,
    resource: '',
    grantedScopes: ['openid', 'profile'],
    policyVersion: 'p1',
    termsVersion: 't1',
    grantedAt: new Date(),
    updatedAt: new Date(),
    revokedAt: null,
  });

  // findOneAndUpdate(...).lean().exec() — exec is the mock we drive per attempt.
  let exec: jest.Mock<() => Promise<Consent>>;
  let findOneAndUpdate: jest.Mock<() => unknown>;
  let service: ConsentService;

  beforeEach(() => {
    exec = jest.fn<() => Promise<Consent>>();
    findOneAndUpdate = jest.fn(() => ({ lean: () => ({ exec }) }));
    const consents = { findOneAndUpdate } as unknown;
    const config = { getOrThrow: () => VERSIONS } as unknown;
    service = new ConsentService(consents as never, config as never);
  });

  const grant = () =>
    service.grant(USER, CLIENT, undefined, ['openid', 'profile'], VERSIONS, ['openid', 'profile']);

  it('happy path: no error => single attempt, returns the document', async () => {
    const doc = makeDoc();
    exec.mockResolvedValueOnce(doc);
    await expect(grant()).resolves.toEqual(doc);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('E11000 once then success => retries exactly once, returns a valid Consent (no 500)', async () => {
    const doc = makeDoc();
    exec
      .mockRejectedValueOnce(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }))
      .mockResolvedValueOnce(doc);
    await expect(grant()).resolves.toEqual(doc);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(2);
    // Both attempts replay the IDENTICAL write (same filter + pipeline) — no over-grant window.
    expect(findOneAndUpdate.mock.calls[0]).toEqual(findOneAndUpdate.mock.calls[1]);
  });

  it('E11000 twice (persistent) => does NOT retry again, propagates unchanged', async () => {
    const dup = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    exec.mockRejectedValue(dup);
    await expect(grant()).rejects.toBe(dup);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(2); // original + one retry, no third attempt
  });

  it('non-11000 error => no retry, propagates unchanged', async () => {
    const other = Object.assign(new Error('network error'), { code: 89 });
    exec.mockRejectedValueOnce(other);
    await expect(grant()).rejects.toBe(other);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
  });
});
