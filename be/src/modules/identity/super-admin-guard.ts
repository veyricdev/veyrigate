import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { type ClientSession, type Connection, type Model, Types } from 'mongoose';
import { LastSuperAdminError } from './identity.errors';
import type { UserTenant } from './user-tenant.service';
import { ADMIN_LOCKED_UNTIL } from './user.service';

/**
 * DEBT-142: every tenant that had an active super_admin keeps at least one after any demote/lock.
 * "Active" = membership `status:'active'` with `super_admin`, user present and not admin-locked
 * (a brute-force lock expires on its own, so it still counts).
 *
 * Mechanism: a Mongo transaction (snapshot, majority) in which the write AND a shared "touch"
 * (`$inc superAdminGuard` on every active super_admin membership of the tenant) run before the
 * survivor count. Counting alone is write skew under snapshot isolation (two demotes both see one
 * survivor); the touch makes two such transactions write the same documents, so one aborts with a
 * write conflict, is retried by the driver on a fresh snapshot and then sees no survivor.
 * Needs a replica set (prod, `aegate-mongo`, `vg-test-mongo`, CI): on a standalone the transaction
 * fails and nothing is written (5xx, fail-closed).
 */
@Injectable()
export class SuperAdminGuard {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel('UserTenant') private readonly memberships: Model<UserTenant>,
    @InjectModel('User') private readonly users: Model<{ lockedUntil?: Date }>,
  ) {}

  /**
   * Run `write` in one transaction. `write` may be re-run by the driver on a transient error, so it
   * must only touch the DB through `session` (audit/revoke run after this resolves).
   */
  async runGuarded<T>(write: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await this.connection.startSession();
    try {
      return await session.withTransaction(() => write(session), {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        maxCommitTimeMS: 5000,
      });
    } finally {
      await session.endSession();
    }
  }

  /**
   * Inside `runGuarded`: throw `LastSuperAdminError` when one of `tenantIds` has no active
   * super_admin other than `targetUserId` (the user being demoted or locked).
   */
  async assertSurvivors(
    tenantIds: string[],
    targetUserId: string,
    session: ClientSession,
  ): Promise<void> {
    const superAdmins = { tenantId: { $in: tenantIds }, status: 'active', roles: 'super_admin' };
    await this.memberships
      .updateMany(superAdmins, { $inc: { superAdminGuard: 1 } }, { session })
      .exec();
    const rest = await this.memberships
      .find(
        { ...superAdmins, userId: { $ne: new Types.ObjectId(targetUserId) } },
        {
          userId: 1,
          tenantId: 1,
        },
      )
      .session(session)
      .lean<Pick<UserTenant, 'userId' | 'tenantId'>[]>()
      .exec();
    const live = await this.users
      .find(
        { _id: { $in: rest.map((m) => m.userId) }, lockedUntil: { $ne: ADMIN_LOCKED_UNTIL } },
        { _id: 1 },
      )
      .session(session)
      .lean<{ _id: Types.ObjectId }[]>()
      .exec();
    const liveIds = new Set(live.map((u) => u._id.toHexString()));
    for (const tenantId of tenantIds) {
      if (!rest.some((m) => m.tenantId === tenantId && liveIds.has(m.userId.toHexString()))) {
        throw new LastSuperAdminError();
      }
    }
  }
}
