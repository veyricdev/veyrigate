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

/** Run 88 T3 (DEBT-581, D88.22): the user's own consents, no tenant filter, owner always filtered. */
describe('ConsentService.listOwn / revokeOwn (run 88)', () => {
  const USER = new Types.ObjectId().toHexString();
  const ID = new Types.ObjectId().toHexString();
  let exec: jest.Mock<() => Promise<unknown>>;
  let query: Record<string, jest.Mock>;
  let model: Record<string, jest.Mock>;
  let service: ConsentService;

  beforeEach(() => {
    exec = jest.fn<() => Promise<unknown>>();
    query = {} as Record<string, jest.Mock>;
    for (const m of ['sort', 'limit', 'lean']) query[m] = jest.fn(() => query);
    query.exec = exec as unknown as jest.Mock;
    model = { find: jest.fn(() => query), findOneAndUpdate: jest.fn(() => query) };
    service = new ConsentService(model as never, { getOrThrow: () => ({}) } as never);
  });

  it('listOwn: active consents of userId only (every tenant), newest update first, capped', async () => {
    exec.mockResolvedValue([]);
    await service.listOwn(USER, 100);
    expect(model.find).toHaveBeenCalledWith({ userId: new Types.ObjectId(USER), revokedAt: null });
    expect(query.sort).toHaveBeenCalledWith({ updatedAt: -1, _id: -1 });
    expect(query.limit).toHaveBeenCalledWith(100);
  });

  it('revokeOwn: one findOneAndUpdate filtered by _id AND userId, $ifNull keeps the first revokedAt', async () => {
    const now = new Date();
    exec.mockResolvedValue({ clientId: 'c', resource: '', revokedAt: null });
    expect(await service.revokeOwn(ID, USER, now)).toEqual({
      consent: { clientId: 'c', resource: '', revokedAt: null },
      alreadyRevoked: false,
    });
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: new Types.ObjectId(ID), userId: new Types.ObjectId(USER) },
      [{ $set: { revokedAt: { $ifNull: ['$revokedAt', now] } } }],
      { returnDocument: 'before', updatePipeline: true },
    );
  });

  it('revokeOwn: already revoked => alreadyRevoked true; nothing matched => null', async () => {
    exec.mockResolvedValueOnce({ clientId: 'c', resource: '', revokedAt: new Date(0) });
    expect((await service.revokeOwn(ID, USER, new Date()))?.alreadyRevoked).toBe(true);
    exec.mockResolvedValueOnce(null);
    expect(await service.revokeOwn(ID, USER, new Date())).toBeNull();
  });
});
