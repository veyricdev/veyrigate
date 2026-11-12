import type { RevokeStep } from '../authentication/authentication.service';
import type { RefreshTokenService } from '../oauth/token/refresh-token.service';

/**
 * Terminate ONE session (shared by `POST /logout` and `/account/sessions`, run 88 D88.19): revoke its
 * refresh families → delete the session + write the `sess_end` tombstone (`deleteSession`) → SWEEP
 * the families again, catching one a racing `/token` exchange inserted meanwhile (DEBT-051, §15
 * inv. 28/29). Stops at the first fault (DEBT-526: a family fault leaves the session alive, so a
 * retry redoes every step), awaits `onFailure(step)` best-effort, then rethrows the original error.
 * Returns how many families were revoked. Every step is idempotent.
 */
export async function revokeOneSession(
  refreshTokens: Pick<RefreshTokenService, 'revokeForSession'>,
  target: { userId: string; ref: string },
  now: Date,
  deleteSession: () => Promise<unknown>,
  onFailure: (failedStep: RevokeStep) => Promise<unknown>,
): Promise<number> {
  let step: RevokeStep = 'pre_revoke';
  try {
    let count = await refreshTokens.revokeForSession(target.userId, target.ref, now);
    step = 'sessions';
    await deleteSession();
    step = 'sweep';
    count += await refreshTokens.revokeForSession(target.userId, target.ref, now);
    return count;
  } catch (err) {
    await onFailure(step).catch(() => undefined);
    throw err;
  }
}
