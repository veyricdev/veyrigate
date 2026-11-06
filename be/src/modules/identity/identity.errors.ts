/**
 * Domain error for a unique-constraint violation (B2.2). Deliberately NOT an HttpException:
 * callers (e.g. registration in B2.4) decide the response, which must not reveal whether an
 * email/identity exists (INV-27).
 */
export class DuplicateError extends Error {
  constructor(readonly entity: string) {
    super(`${entity} already exists`);
    this.name = 'DuplicateError';
  }
}

/** Run a write; map Mongo E11000 to `DuplicateError(entity)`, rethrow anything else. */
export async function mapDuplicate<R>(entity: string, write: () => Promise<R>): Promise<R> {
  try {
    return await write();
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      throw new DuplicateError(entity);
    }
    throw err;
  }
}

/**
 * DEBT-142: the write would leave a tenant without an active super_admin (membership active,
 * `super_admin` role, user present and not admin-locked). Thrown inside the guard's transaction,
 * so nothing is written; the admin layer maps it to 409 with a fixed description.
 */
export class LastSuperAdminError extends Error {
  constructor() {
    super('at least one active super_admin must remain');
    this.name = 'LastSuperAdminError';
  }
}
