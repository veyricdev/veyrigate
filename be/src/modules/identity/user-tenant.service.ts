import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, type Model, Types } from 'mongoose';
import { mapDuplicate } from './identity.errors';
import type { TenantContext } from './tenant-context/tenant-context';
import { TenantScopedRepository } from './tenant-context/tenant-scoped.repository';

export interface UserTenant {
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

  listMembers(ctx: TenantContext): Promise<UserTenant[]> {
    return this.repo.find(ctx);
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
