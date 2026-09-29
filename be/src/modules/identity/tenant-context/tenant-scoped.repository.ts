import type { DeleteResult, Model, QueryFilter, UpdateQuery, UpdateResult } from 'mongoose';
import type { TenantContext } from './tenant-context';

/**
 * Tenant-scoped data access (B2.1, INV-24). Every call requires a `TenantContext` and puts
 * `tenantId` **into the query itself** (merged last, so a caller-supplied `tenantId` is
 * overridden) — never find-then-check. Only for collections that carry `tenantId`
 * (UserTenant now, Client in B3); User/FederatedIdentity/Tenant are global (§9.10).
 */
export class TenantScopedRepository<T extends { tenantId: string }> {
  constructor(private readonly model: Model<T>) {}

  findOne(ctx: TenantContext, filter: QueryFilter<T> = {}): Promise<T | null> {
    return this.model.findOne(this.scope(ctx, filter)).lean<T>().exec();
  }

  find(ctx: TenantContext, filter: QueryFilter<T> = {}): Promise<T[]> {
    return this.model.find(this.scope(ctx, filter)).lean<T[]>().exec();
  }

  async create(ctx: TenantContext, doc: Omit<T, 'tenantId'>): Promise<T> {
    // tenantId from ctx is spread last → any tenantId in `doc` is overwritten.
    const created = await new this.model({ ...doc, tenantId: ctx.tenantId }).save();
    return created.toObject() as T;
  }

  updateOne(
    ctx: TenantContext,
    filter: QueryFilter<T>,
    update: UpdateQuery<T>,
  ): Promise<UpdateResult> {
    return this.model.updateOne(this.scope(ctx, filter), withoutTenantId(update)).exec();
  }

  deleteOne(ctx: TenantContext, filter: QueryFilter<T>): Promise<DeleteResult> {
    return this.model.deleteOne(this.scope(ctx, filter)).exec();
  }

  private scope(ctx: TenantContext, filter: QueryFilter<T>): QueryFilter<T> {
    if (!ctx?.tenantId) {
      throw new Error('TenantContext required');
    }
    return { ...filter, tenantId: ctx.tenantId } as QueryFilter<T>;
  }
}

/** Drop any attempt to change `tenantId` (top-level or inside an update operator). */
function withoutTenantId<T>(update: UpdateQuery<T>): UpdateQuery<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(update as Record<string, unknown>)) {
    if (key === 'tenantId') continue;
    if (key.startsWith('$') && value && typeof value === 'object') {
      const ops = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(
          ([field, target]) => field !== 'tenantId' && target !== 'tenantId',
        ),
      );
      if (Object.keys(ops).length) out[key] = ops;
      continue;
    }
    out[key] = value;
  }
  return out as UpdateQuery<T>;
}
