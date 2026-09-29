import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, type Model, type Types } from 'mongoose';
import { hashPassword } from '../../common/crypto/crypto.util';
import { mapDuplicate } from './identity.errors';

interface UserDoc {
  _id: Types.ObjectId;
  email: string;
  passwordHash?: string;
  profile: Record<string, unknown>;
  emailVerifiedAt?: Date;
  failedLoginCount: number;
  lockedUntil?: Date;
  createdAt: Date;
  updatedAt: Date;
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

  /** Change email; `sub` is unaffected. Duplicate email → DuplicateError. */
  async changeEmail(sub: string, email: string): Promise<UserView | null> {
    return this.update(sub, { email: normalizeEmail(email) });
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
