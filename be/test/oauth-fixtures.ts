import { Types, type Connection } from 'mongoose';

/**
 * Shared int-test fixtures (run 35, DEBT-116/141/144): a REAL user with a membership in the
 * client's tenant, as `/authorize` (membership) and the code grant re-check (user exists, not
 * locked, active member, consent covered) now require. Never change a client's tenant to dodge
 * these checks -- seed the owner in `client.tenantId` instead.
 */
export interface SeedOAuthUserOptions {
  tenantId: string;
  status?: 'active' | 'suspended';
  lockedUntil?: Date;
}

export interface SeedConsentOptions {
  userId: string;
  clientId: string;
  resource?: string;
  scopes: string[];
  /** Default to the int-specs' consent config (`'1'`/`'1'`). */
  policyVersion?: string;
  termsVersion?: string;
}

/** Create a verified User + UserTenant in `tenantId`; returns the user id (hex). */
export async function seedOAuthUser(conn: Connection, opts: SeedOAuthUserOptions): Promise<string> {
  const userId = new Types.ObjectId();
  await conn.model('User').create({
    _id: userId,
    email: `oauth-${userId.toHexString()}@fixture.test`,
    emailVerifiedAt: new Date(),
    ...(opts.lockedUntil ? { lockedUntil: opts.lockedUntil } : {}),
  });
  await conn.model('UserTenant').create({
    userId,
    tenantId: opts.tenantId,
    status: opts.status ?? 'active',
  });
  return userId.toHexString();
}

/**
 * Upsert a current consent covering `scopes` (merged into any existing grant), as the code grant
 * re-check expects for a code minted directly in Redis (no consent screen ran).
 */
export async function seedConsent(conn: Connection, opts: SeedConsentOptions): Promise<void> {
  await conn.model('Consent').updateOne(
    {
      userId: new Types.ObjectId(opts.userId),
      clientId: opts.clientId,
      resource: opts.resource ?? '',
    },
    {
      $addToSet: { grantedScopes: { $each: opts.scopes } },
      $set: {
        policyVersion: opts.policyVersion ?? '1',
        termsVersion: opts.termsVersion ?? '1',
        revokedAt: null,
      },
    },
    { upsert: true },
  );
}

/**
 * For a code minted directly in Redis: make its owner pass the code grant re-check -- upsert the
 * User (by id, keeps an existing one), an ACTIVE membership in `tenantId` (the client's tenant)
 * and a covered consent for the code's client/resource/scope.
 */
export async function seedCodeGrant(
  conn: Connection,
  data: { userId: string; clientId: string; resource?: string; scope: string },
  tenantId: string,
): Promise<void> {
  const userId = new Types.ObjectId(data.userId);
  await conn
    .model('User')
    .updateOne(
      { _id: userId },
      { $setOnInsert: { email: `oauth-${data.userId}@fixture.test`, emailVerifiedAt: new Date() } },
      { upsert: true },
    );
  await conn
    .model('UserTenant')
    .updateOne({ userId, tenantId }, { $setOnInsert: { status: 'active' } }, { upsert: true });
  await seedConsent(conn, {
    userId: data.userId,
    clientId: data.clientId,
    resource: data.resource,
    scopes: data.scope.split(' ').filter(Boolean),
  });
}
