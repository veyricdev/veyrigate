import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

export const DEFAULT_TENANT_ID = 'default-tenant';

export interface Tenant {
  id: string;
  name: string;
}

/** Tenants (global collection, §9.10) + idempotent `default-tenant` seed at boot (B2.2). */
@Injectable()
export class TenantService implements OnApplicationBootstrap {
  constructor(@InjectModel('Tenant') private readonly tenants: Model<Tenant>) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.seedDefault();
  }

  /** Upsert with $setOnInsert: running twice (or on 2 instances at once) never duplicates. */
  async seedDefault(): Promise<void> {
    try {
      await this.tenants
        .updateOne(
          { id: DEFAULT_TENANT_ID },
          { $setOnInsert: { id: DEFAULT_TENANT_ID, name: 'Default' } },
          { upsert: true },
        )
        .exec();
    } catch (err) {
      // Concurrent upsert lost the race on the unique index → the tenant exists: success.
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }

  findById(id: string): Promise<Tenant | null> {
    return this.tenants.findOne({ id }, { _id: 0, id: 1, name: 1 }).lean<Tenant>().exec();
  }
}
