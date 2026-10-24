/**
 * Dependency outage ⇒ 503 `temporarily_unavailable` + `Retry-After` (run 53c, plan §6.2). Still
 * fail-closed: no token, no session, no `active` — only a clearer signal than a 500 (or a 401 /
 * `active:false`, DEBT-394) so clients and resource servers can tell an outage from a bad token.
 */

/** Seconds a client should wait before retrying after a dependency outage. */
export const DEPENDENCY_RETRY_AFTER_SEC = 5;

/**
 * Redis could not answer. ONLY the shapes observed in the run-53c kill test (runs/53c-B7.3/log.md,
 * proxy refused / blackholed), matched exactly: anything else stays a 500 (fail-closed either way).
 * - ioredis `MaxRetriesPerRequestError` (offline queue flushed after a failed reconnect);
 * - ioredis plain `Error('Command timed out')` (`commandTimeout`).
 */
export function isRedisUnavailable(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'MaxRetriesPerRequestError' ||
      (err.constructor === Error && err.message === 'Command timed out'))
  );
}

/**
 * DEBT-394: the key provider (Vault) could not produce the verification key set, so a token cannot
 * be judged either way. Thrown by `TokenVerifier`; callers rethrow it instead of answering 401 /
 * `active:false`. The cause is kept for logs (`errorForLog` prints names/frames only), never the
 * message.
 */
export class KeyProviderUnavailableError extends Error {
  constructor(cause: unknown) {
    super('key provider unavailable', { cause });
    this.name = 'KeyProviderUnavailableError';
  }
}

export function isDependencyUnavailable(err: unknown): boolean {
  return err instanceof KeyProviderUnavailableError || isRedisUnavailable(err);
}
