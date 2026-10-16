import { jest } from '@jest/globals';
import type { Model } from 'mongoose';
import type { AuditService } from '../../security/audit/audit.service';
import type { ResourceService } from '../../resources/resource.service';
import type { TokenService } from './token.service';
import { RefreshTokenService } from './refresh-token.service';

/**
 * B4.7 guard (fold #5): `revokeWhere` is the ONE place that revokes RefreshToken documents and it
 * must NEVER issue `updateMany({})` (that would revoke every family of every user). These negative
 * unit tests lock the empty / invalid-scope guard so a future refactor cannot drop it: every bad
 * scope must reject AND leave `updateMany` uncalled.
 */
describe('RefreshTokenService revoke-scope guard (negative, no DB)', () => {
  let updateMany: jest.Mock;
  let svc: RefreshTokenService;

  beforeEach(() => {
    // `exec()` is never reached when the guard throws; include it so a regression (guard removed)
    // would resolve instead of throwing, making the "did not reject" failure obvious.
    const exec = jest.fn(async () => ({ modifiedCount: 0 }));
    updateMany = jest.fn(() => ({ exec }));
    const model = { updateMany } as unknown as Model<Record<string, unknown>>;
    svc = new RefreshTokenService(
      model,
      {} as unknown as TokenService,
      {} as unknown as AuditService,
      {} as unknown as ResourceService,
    );
  });

  const now = new Date();

  it('revokeAllForUser("") rejects and never calls updateMany', async () => {
    await expect(svc.revokeAllForUser('', now)).rejects.toThrow();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('revokeAllForUser(non-hex) rejects (ObjectId cast) and never calls updateMany', async () => {
    await expect(svc.revokeAllForUser('not-a-hex-id', now)).rejects.toThrow();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('revokeForSession(userId, "") rejects and never calls updateMany', async () => {
    await expect(svc.revokeForSession('507f1f77bcf86cd799439011', '', now)).rejects.toThrow();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('revokeFamily("", clientId) rejects (missing familyId) and never calls updateMany', async () => {
    await expect(svc.revokeFamily('', 'rp-client', now)).rejects.toThrow();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('revokeFamily(familyId, "") rejects (missing clientId) and never calls updateMany', async () => {
    await expect(svc.revokeFamily('fam-1', '', now)).rejects.toThrow();
    expect(updateMany).not.toHaveBeenCalled();
  });
});
