import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, type Model, Types } from 'mongoose';
import { mapDuplicate } from './identity.errors';
import type { TenantContext } from './tenant-context/tenant-context';
import { TenantScopedRepository } from './tenant-context/tenant-scoped.repository';

export interface UserTenant {
  _id?: Types.ObjectId;
  userId: Types.ObjectId;
  tenantId: string;
  status: string;
  roles: string[];
  createdAt: Date;
}

/**
 * Membership of users in tenants (B2.2). Request-driven reads/writes go through
 * `TenantScopedRepository` (tenant from `TenantContext` only). `addMembership` and
 * `isActiveMember` take a tenantId from trusted server code (seed/registration, the
 * session in `TenantGuard`) — never from request input.
 */
@Injectable()
export class UserTenantService {
  private readonly repo: TenantScopedRepository<UserTenant>;

  constructor(@InjectModel('UserTenant') private readonly model: Model<UserTenant>) {
    this.repo = new TenantScopedRepository(model);
  }

  /** Duplicate (userId, tenantId) → DuplicateError. */
  async addMembership(userId: string, tenantId: string, roles: string[] = []): Promise<UserTenant> {
    const doc = await mapDuplicate('UserTenant', () =>
      this.model.create({ userId: new Types.ObjectId(userId), tenantId, roles }),
    );
    return doc.toObject();
  }

  async isActiveMember(userId: string, tenantId: string): Promise<boolean> {
    if (!isValidObjectId(userId)) return false;
    const found = await this.model.exists({ userId, tenantId, status: 'active' }).exec();
    return found !== null;
  }

  /**
   * Roles of the user's ACTIVE membership in `tenantId`, or null when there is none (absent or
   * suspended). `tenantId` must come from trusted server code (B6.1: the issuing client's
   * `tenantId`), never from request input. A DB fault propagates (caller fails closed).
   */
  async activeRoles(userId: string, tenantId: string): Promise<string[] | null> {
    if (!isValidObjectId(userId)) return null;
    const found = await this.model
      .findOne({ userId, tenantId, status: 'active' }, { roles: 1 })
      .lean()
      .exec();
    return found ? (found.roles ?? []) : null;
  }

  listMembers(ctx: TenantContext): Promise<UserTenant[]> {
    return this.repo.find(ctx);
  }

  /**
   * Admin list (B6.3b): memberships of the token's tenant ordered by `_id`, strictly after the
   * cursor (a membership `_id`). `userId` narrows to one user (exact email match resolved by the
   * caller). The caller validates `after` as an ObjectId.
   */
  listMembersPage(
    ctx: TenantContext,
    filter: { status?: string; userId?: string },
    after: string | undefined,
    limit: number,
  ): Promise<UserTenant[]> {
    return this.repo.find(
      ctx,
      {
        ...(filter.status !== undefined ? { status: filter.status } : {}),
        ...(filter.userId !== undefined ? { userId: new Types.ObjectId(filter.userId) } : {}),
        ...(after !== undefined ? { _id: { $gt: new Types.ObjectId(after) } } : {}),
      },
      { sort: { _id: 1 }, limit },
    );
  }

  /**
   * Every membership of a user in EVERY tenant (B6.3b). Trusted server use only: decides whether
   * a tenant_admin may touch a user whose global state (lock, sessions) affects other tenants.
   * Never returned to a client.
   */
  async membershipsOf(
    userId: string,
  ): Promise<Pick<UserTenant, 'tenantId' | 'status' | 'roles'>[]> {
    if (!isValidObjectId(userId)) return [];
    return this.model
      .find({ userId: new Types.ObjectId(userId) }, { tenantId: 1, status: 1, roles: 1 })
      .lean<Pick<UserTenant, 'tenantId' | 'status' | 'roles'>[]>()
      .exec();
  }

  /**
   * Replace the roles of a membership of the token's tenant atomically (B6.3b) and return the
   * membership BEFORE the write (audit diff), or null when nothing matched. `unlessRole` makes the
   * write conditional ("target does not hold that role") inside the same filter, so a concurrent
   * grant cannot slip between a check and the write.
   */
  replaceRoles(
    ctx: TenantContext,
    userId: string,
    roles: string[],
    unlessRole?: string,
  ): Promise<UserTenant | null> {
    if (!isValidObjectId(userId)) return Promise.resolve(null);
    return this.repo.findOneAndUpdate(
      ctx,
      {
        userId: new Types.ObjectId(userId),
        ...(unlessRole !== undefined ? { roles: { $ne: unlessRole } } : {}),
      },
      { $set: { roles } },
    );
  }

  findMember(ctx: TenantContext, userId: string): Promise<UserTenant | null> {
    if (!isValidObjectId(userId)) return Promise.resolve(null);
    return this.repo.findOne(ctx, { userId: new Types.ObjectId(userId) });
  }

  async setRoles(ctx: TenantContext, userId: string, roles: string[]): Promise<boolean> {
    if (!isValidObjectId(userId)) return false;
    const res = await this.repo.updateOne(
      ctx,
      { userId: new Types.ObjectId(userId) },
      { $set: { roles } },
    );
    return res.matchedCount === 1;
  }

  async removeMember(ctx: TenantContext, userId: string): Promise<boolean> {
    if (!isValidObjectId(userId)) return false;
    const res = await this.repo.deleteOne(ctx, { userId: new Types.ObjectId(userId) });
    return res.deletedCount === 1;
  }
}
