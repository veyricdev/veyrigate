// Bulk data of the backup/restore drill (T1 AC drill 1): 2 000 users sharing ONE Argon2 hash (200 of them
// carry the legacy fields removed in run 87 + 50 an expired temporary lock, for runbook-deploy section 15),
// their memberships, 500 consents, 2 000 refresh tokens (half revoked, all expiring in the future) and 5 000
// audit events of the last 24 h (inside the TTL). Emails are drill-<n>@drill.invalid; token hashes are random.
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { hex, mongoose } from './lib.mjs';

const require = createRequire(import.meta.url);
const { hash } = require('@node-rs/argon2');
const { ObjectId } = mongoose.mongo;

export const DRILL_COUNTS = { users: 2000, legacy: 200, expiredLocks: 50, consents: 500, refreshTokens: 2000, audits: 5000 };

/** Insert into `db` (a drill db handle from the native driver). Returns the counts inserted. */
export async function seedDrillData(db, { adminResource }) {
  const now = Date.now();
  const passwordHash = await hash(hex(16)); // nobody logs in as these users
  const users = Array.from({ length: DRILL_COUNTS.users }, (_, i) => {
    const legacy = i < DRILL_COUNTS.legacy;
    return {
      _id: new ObjectId(),
      email: `drill-${i}@drill.invalid`,
      passwordHash,
      profile: {},
      emailVerifiedAt: new Date(now - 86_400_000),
      createdAt: new Date(now - 86_400_000),
      updatedAt: new Date(now - 86_400_000),
      ...(legacy ? { failedLoginCount: 3, lockTransitionNonce: hex(8) } : {}),
      ...(legacy && i < DRILL_COUNTS.expiredLocks ? { lockedUntil: new Date(now - 3_600_000) } : {}),
    };
  });
  await db.collection('users').insertMany(users, { ordered: false });
  await db.collection('usertenants').insertMany(
    users.map((u) => ({ userId: u._id, tenantId: 'default-tenant', status: 'active', roles: [], createdAt: new Date(now) })),
    { ordered: false },
  );
  await db.collection('consents').insertMany(
    users.slice(0, DRILL_COUNTS.consents).map((u) => ({
      userId: u._id,
      clientId: 'fe-sso-test',
      resource: '',
      grantedScopes: ['openid', 'email'],
      policyVersion: '1',
      termsVersion: '1',
      grantedAt: new Date(now - 3_600_000),
      updatedAt: new Date(now - 3_600_000),
    })),
    { ordered: false },
  );
  await db.collection('refreshtokens').insertMany(
    Array.from({ length: DRILL_COUNTS.refreshTokens }, (_, i) => ({
      tokenHash: hex(32),
      familyId: randomUUID(),
      userId: users[i % users.length]._id,
      clientId: 'fe-admin',
      scope: ['openid', 'offline_access', 'admin.read'],
      resource: adminResource,
      issuedAt: new Date(now - 3_600_000),
      expiresAt: new Date(now + 30 * 86_400_000),
      ...(i % 2 === 0 ? { revokedAt: new Date(now - 1_800_000), familyRevokedAt: new Date(now - 1_800_000) } : {}),
    })),
    { ordered: false },
  );
  await db.collection('auditlogs').insertMany(
    Array.from({ length: DRILL_COUNTS.audits }, (_, i) => ({
      eventId: randomUUID(),
      timestamp: new Date(now - (i % 1440) * 60_000),
      actorType: 'user',
      actorId: users[i % users.length]._id.toHexString(),
      tenantId: 'default-tenant',
      action: 'AUTH_LOGIN_SUCCESS',
      result: 'success',
    })),
    { ordered: false },
  );
  return { ...DRILL_COUNTS };
}
