import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, type Model, type Types } from 'mongoose';
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
  }): Promise<UserView> {
    const doc = await mapDuplicate('User', async () =>
      this.users.create({
        email: normalizeEmail(input.email),
        passwordHash: input.password ? await hashPassword(input.password) : undefined,
        profile: input.profile ?? {},
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

  async findById(sub: string): Promise<UserView | null> {
    if (!isValidObjectId(sub)) return null;
    const doc = await this.users.findById(sub).select(PUBLIC_FIELDS).lean<UserDoc>().exec();
    return doc ? toView(doc) : null;
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

  async resetFailedLogins(sub: string): Promise<UserView | null> {
    if (!isValidObjectId(sub)) return null;
    const doc = await this.users
      .findByIdAndUpdate(
        sub,
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

  async setPassword(sub: string, passwordHash: string): Promise<UserView | null> {
    return this.update(
      sub,
      { passwordHash, emailVerifiedAt: new Date(), failedLoginCount: 0 },
      {
        lockedUntil: 1,
      },
    );
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

  private async update(
    sub: string,
    set: Record<string, unknown>,
    unset?: Record<string, 1>,
  ): Promise<UserView | null> {
    if (!isValidObjectId(sub)) return null;
    const doc = await mapDuplicate('User', () =>
      this.users
        .findByIdAndUpdate(
          sub,
          { $set: set, ...(unset ? { $unset: unset } : {}) },
          { returnDocument: 'after', runValidators: true },
        )
        .select(PUBLIC_FIELDS)
        .lean<UserDoc>()
        .exec(),
    );
    return doc ? toView(doc) : null;
  }
}
