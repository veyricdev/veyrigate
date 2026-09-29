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
