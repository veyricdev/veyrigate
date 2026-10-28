import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, type Model, type QueryFilter, type Types } from 'mongoose';
import { hashPassword } from '../../common/crypto/crypto.util';
import { mapDuplicate } from './identity.errors';
import { randomUUID } from 'node:crypto';

interface UserDoc {
  _id: Types.ObjectId;
  email: string;
  passwordHash?: string;
  profile: Record<string, unknown>;
  emailVerifiedAt?: Date;
  failedLoginCount: number;
  lockedUntil?: Date;
  adminLockLevel?: AdminLockLevel;
  /** Per-user strictly increasing mark of admin lock/unlock writes (run 57). Never in a view. */
  adminLockMarkAt?: Date;
  lockTransitionNonce?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserWithPassword extends UserView {
  passwordHash?: string;
}

export interface FailedLoginResult {
  user: UserView;
  newlyLocked: boolean;
}

/** Public user shape. `sub` = `User._id` (A6), immutable. Never contains `passwordHash`. */
export interface UserView {
  sub: string;
  email: string;
  profile: Record<string, unknown>;
  emailVerifiedAt?: Date;
  failedLoginCount: number;
  lockedUntil?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Status fields that may be updated (existing schema fields only — no new `status`). */
export type UserStatusPatch = Partial<
  Pick<UserDoc, 'emailVerifiedAt' | 'failedLoginCount' | 'lockedUntil'>
>;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const PUBLIC_FIELDS = '-passwordHash -mfaSecret';

/** Admin lock = "until an admin unlocks" (B6.3b). Only admin unlock clears it, never a reset. */
export const ADMIN_LOCKED_UNTIL = new Date('9999-12-31T23:59:59.999Z');

/** Who set an admin lock (DEBT-153): only that level or higher may lift it. */
export type AdminLockLevel = 'tenant_admin' | 'super_admin';

/**
 * Mark of an admin lock/unlock write (run 57, DEBT-420): `max(now, prev + 1 ms)`. Strictly increases
 * per user in the order Mongo applies the writes, whatever order the responses reach Node in; the
 * lock/unlock audit uses it as its timestamp. `adminLockMarkExpr` is the same rule inside an update.
 */
export function nextAdminLockMark(prev: Date | undefined, now: Date): Date {
  return new Date(Math.max(now.getTime(), (prev?.getTime() ?? 0) + 1));
}

const adminLockMarkExpr = (now: Date) => ({
  $max: [now, { $add: [{ $ifNull: ['$adminLockMarkAt', new Date(0)] }, 1] }],
});

/**
 * Users whose lock a tenant_admin may change: no admin lock (unlocked or brute-force lock), or an
 * admin lock of level `tenant_admin`. A sentinel without level (pre-run-56 data) counts as
 * super_admin (fail-closed). Used inside the write filter so a concurrent lock cannot slip past.
 */
const tenantAdminMayChangeLock = (sub: string): QueryFilter<UserDoc> => ({
  _id: sub,
  $or: [{ lockedUntil: { $ne: ADMIN_LOCKED_UNTIL } }, { adminLockLevel: 'tenant_admin' }],
});

function toView(doc: UserDoc): UserView {
  return {
    sub: doc._id.toString(),
    email: doc.email,
    profile: doc.profile ?? {},
    emailVerifiedAt: doc.emailVerifiedAt,
    failedLoginCount: doc.failedLoginCount ?? 0,
    lockedUntil: doc.lockedUntil,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** Users (global collection, §9.10). Internal only — no controller yet (B2.2). */
@Injectable()
export class UserService {
  constructor(@InjectModel('User') private readonly users: Model<UserDoc>) {}

  /** Create a user; `password` (if any) is hashed with Argon2id here. Duplicate email → DuplicateError. */
  async create(input: {
    email: string;
    password?: string;
    profile?: Record<string, unknown>;
    /** Set only for an email the caller already verified (federation, B5.2). */
    emailVerifiedAt?: Date;
  }): Promise<UserView> {
    const doc = await mapDuplicate('User', async () =>
      this.users.create({
        email: normalizeEmail(input.email),
        passwordHash: input.password ? await hashPassword(input.password) : undefined,
        profile: input.profile ?? {},
        ...(input.emailVerifiedAt ? { emailVerifiedAt: input.emailVerifiedAt } : {}),
      }),
    );
    return toView(doc.toObject());
  }

  async createWithPasswordHash(email: string, passwordHash: string): Promise<UserView> {
    const doc = await mapDuplicate('User', () =>
      this.users.create({ email: normalizeEmail(email), passwordHash, profile: {} }),
    );
    return toView(doc.toObject());
  }

  /**
   * Internal compensation only (B5.2 provisioning race): delete a user THIS request just created.
   * No route, never exposed to admin/RP input.
   */
  async deleteById(sub: string): Promise<boolean> {
    if (!isValidObjectId(sub)) return false;
    return (await this.users.deleteOne({ _id: sub }).exec()).deletedCount === 1;
  }

  async findById(sub: string): Promise<UserView | null> {
    if (!isValidObjectId(sub)) return null;
    const doc = await this.users.findById(sub).select(PUBLIC_FIELDS).lean<UserDoc>().exec();
    return doc ? toView(doc) : null;
  }

  /** Batch read by `sub` (B6.3b admin list: one `$in` per page). Invalid ids are skipped. */
  async findByIds(subs: string[]): Promise<UserView[]> {
    const ids = subs.filter((s) => isValidObjectId(s));
    if (ids.length === 0) return [];
    const docs = await this.users
      .find({ _id: { $in: ids } })
      .select(PUBLIC_FIELDS)
      .lean<UserDoc[]>()
      .exec();
    return docs.map(toView);
  }

  async findByEmail(email: string): Promise<UserView | null> {
    const doc = await this.users
      .findOne({ email: normalizeEmail(email) })
      .select(PUBLIC_FIELDS)
      .lean<UserDoc>()
      .exec();
    return doc ? toView(doc) : null;
  }

  async findByEmailForAuthentication(email: string): Promise<UserWithPassword | null> {
    const doc = await this.users
      .findOne({ email: normalizeEmail(email) })
      .select('+passwordHash')
      .lean<UserDoc>()
      .exec();
    return doc ? { ...toView(doc), passwordHash: doc.passwordHash } : null;
  }

  /** Change email; `sub` is unaffected. Duplicate email → DuplicateError. */
  async changeEmail(sub: string, email: string): Promise<UserView | null> {
    if (!isValidObjectId(sub)) return null;
    const doc = await mapDuplicate('User', () =>
      this.users
        .findByIdAndUpdate(
          sub,
          { $set: { email: normalizeEmail(email) }, $unset: { emailVerifiedAt: 1 } },
          { returnDocument: 'after', runValidators: true },
        )
        .select(PUBLIC_FIELDS)
        .lean<UserDoc>()
        .exec(),
    );
    return doc ? toView(doc) : null;
  }

  async recordFailedLogin(sub: string, now = new Date()): Promise<FailedLoginResult | null> {
    if (!isValidObjectId(sub)) return null;
    const lockUntil = new Date(now.getTime() + 15 * 60 * 1000);
    const nonce = randomUUID();
    const doc = await this.users
      .findByIdAndUpdate(
        sub,
        [
          {
            $set: {
              failedLoginCount: {
                $cond: [
                  {
                    $and: [
                      { $ne: [{ $type: '$lockedUntil' }, 'missing'] },
                      { $lte: ['$lockedUntil', now] },
                    ],
                  },
                  1,
                  { $add: [{ $ifNull: ['$failedLoginCount', 0] }, 1] },
                ],
              },
            },
          },
          {
            $set: {
              lockedUntil: {
                $cond: [
                  {
                    $and: [
                      { $gte: ['$failedLoginCount', 5] },
                      { $not: [{ $gt: ['$lockedUntil', now] }] },
                    ],
                  },
                  lockUntil,
                  '$lockedUntil',
                ],
              },
              lockTransitionNonce: {
                $cond: [
                  {
                    $and: [
                      { $gte: ['$failedLoginCount', 5] },
                      { $not: [{ $gt: ['$lockedUntil', now] }] },
                    ],
                  },
                  nonce,
                  '$lockTransitionNonce',
                ],
              },
            },
          },
        ],
        { returnDocument: 'after', updatePipeline: true },
      )
      .select(`${PUBLIC_FIELDS} +lockTransitionNonce`)
      .lean<UserDoc>()
      .exec();
    if (!doc) return null;
    const newlyLocked = doc.lockTransitionNonce === nonce;
    if (newlyLocked)
      await this.users.updateOne(
        { _id: sub, lockTransitionNonce: nonce },
        { $unset: { lockTransitionNonce: 1 } },
      );
    return { user: toView(doc), newlyLocked };
  }

  /**
   * Login success path (DEBT-154): clear the counter and an EXPIRED lock, but only while the user is
   * not locked at write time (`lockedUntil` missing, null or <= now). An admin lock or a brute-force
   * lock set after the login read its snapshot does not match => null, and login must fail. Admin
   * unlock uses `adminUnlock`.
   */
  async clearFailedLoginsIfUnlocked(sub: string, now = new Date()): Promise<UserView | null> {
    if (!isValidObjectId(sub)) return null;
    const doc = await this.users
      .findOneAndUpdate(
        { _id: sub, lockedUntil: { $not: { $gt: now } } },
        { $set: { failedLoginCount: 0 }, $unset: { lockedUntil: 1 } },
        { returnDocument: 'after' },
      )
      .select(PUBLIC_FIELDS)
      .lean<UserDoc>()
      .exec();
    return doc ? toView(doc) : null;
  }

  async verifyEmail(sub: string, at = new Date()): Promise<UserView | null> {
    return this.update(sub, { emailVerifiedAt: at });
  }

  /**
   * New password (reset): clears the counter and a brute-force lock (B2.4), but NEVER an admin lock
   * (`ADMIN_LOCKED_UNTIL`) - self-service must not undo an admin decision. One atomic pipeline.
   */
  async setPassword(sub: string, passwordHash: string): Promise<UserView | null> {
    if (!isValidObjectId(sub)) return null;
    const doc = await this.users
      .findByIdAndUpdate(
        sub,
        [
          {
            $set: {
              passwordHash: { $literal: passwordHash }, // a hash starts with `$`: not a field path
              emailVerifiedAt: new Date(),
              failedLoginCount: 0,
              lockedUntil: {
                $cond: [{ $eq: ['$lockedUntil', ADMIN_LOCKED_UNTIL] }, '$lockedUntil', '$$REMOVE'],
              },
            },
          },
        ],
        { returnDocument: 'after', updatePipeline: true },
      )
      .select(PUBLIC_FIELDS)
      .lean<UserDoc>()
      .exec();
    return doc ? toView(doc) : null;
  }

  /**
   * Admin lock until an admin unlocks (B6.3b), recording its level, in ONE atomic pipeline write
   * that also bumps the per-user mark (run 57). super_admin always (re)sets level `super_admin`;
   * tenant_admin never lowers a higher-level (or legacy unlevelled) admin lock: the level is kept,
   * the write (and its mark) still happens. null = no such user.
   */
  async adminLock(
    sub: string,
    level: AdminLockLevel,
    now = new Date(),
  ): Promise<{ user: UserView; lockMarkAt: Date } | null> {
    if (!isValidObjectId(sub)) return null;
    const keepHigher = {
      $and: [
        { $eq: ['$lockedUntil', ADMIN_LOCKED_UNTIL] },
        { $ne: ['$adminLockLevel', 'tenant_admin'] },
      ],
    };
    const doc = await this.users
      .findOneAndUpdate(
        { _id: sub },
        [
          {
            $set: {
              lockedUntil: ADMIN_LOCKED_UNTIL,
              adminLockLevel:
                level === 'super_admin'
                  ? 'super_admin'
                  : { $cond: [keepHigher, { $ifNull: ['$adminLockLevel', '$$REMOVE'] }, level] },
              adminLockMarkAt: adminLockMarkExpr(now),
            },
          },
        ],
        { returnDocument: 'after', updatePipeline: true },
      )
      .select(PUBLIC_FIELDS)
      .lean<UserDoc>()
      .exec();
    return doc ? { user: toView(doc), lockMarkAt: doc.adminLockMarkAt as Date } : null;
  }

  /**
   * Admin unlock (DEBT-147/153): clear the lock, its level and the counter (and bump the run-57
   * mark) in ONE write and return the document BEFORE it plus the mark written (the caller audits from that, not from an earlier read). A tenant_admin
   * may not lift a super_admin (or legacy unlevelled) lock: 'forbidden'. null = no such user.
   */
  async adminUnlock(
    sub: string,
    actorIsSuperAdmin: boolean,
    now = new Date(),
  ): Promise<{ before: UserView; unlockMarkAt: Date } | 'forbidden' | null> {
    if (!isValidObjectId(sub)) return null;
    const before = await this.users
      .findOneAndUpdate(
        actorIsSuperAdmin ? { _id: sub } : tenantAdminMayChangeLock(sub),
        [
          { $set: { failedLoginCount: 0, adminLockMarkAt: adminLockMarkExpr(now) } },
          { $unset: ['lockedUntil', 'adminLockLevel'] },
        ],
        { returnDocument: 'before', updatePipeline: true },
      )
      .select(PUBLIC_FIELDS)
      .lean<UserDoc>()
      .exec();
    // The pre-image is the pipeline's input (atomic), so the mark written is recomputed exactly.
    if (before)
      return {
        before: toView(before),
        unlockMarkAt: nextAdminLockMark(before.adminLockMarkAt, now),
      };
    if (actorIsSuperAdmin) return null;
    return (await this.users.exists({ _id: sub }).exec()) ? 'forbidden' : null;
  }

  async updateStatus(sub: string, patch: UserStatusPatch): Promise<UserView | null> {
    const { emailVerifiedAt, failedLoginCount, lockedUntil } = patch;
    const set = Object.fromEntries(
      Object.entries({ emailVerifiedAt, failedLoginCount, lockedUntil }).filter(
        ([, v]) => v !== undefined,
      ),
    );
    return this.update(sub, set);
  }

  private async update(sub: string, set: Record<string, unknown>): Promise<UserView | null> {
    if (!isValidObjectId(sub)) return null;
    const doc = await mapDuplicate('User', () =>
      this.users
        .findByIdAndUpdate(sub, { $set: set }, { returnDocument: 'after', runValidators: true })
        .select(PUBLIC_FIELDS)
        .lean<UserDoc>()
        .exec(),
    );
    return doc ? toView(doc) : null;
  }
}
