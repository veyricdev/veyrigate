import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type Model, Types } from 'mongoose';
import { mapDuplicate } from './identity.errors';

export interface FederatedIdentity {
  userId: Types.ObjectId;
  provider: string;
  providerId: string;
  email?: string;
  emailVerified: boolean;
  createdAt: Date;
  lastLoginAt?: Date;
}

/**
 * External identities (global collection, B2.2). Lookup/link strictly by `provider + providerId`;
 * never by email — auto-linking on email is forbidden (INV-22).
 */
@Injectable()
export class FederatedIdentityService {
  constructor(
    @InjectModel('FederatedIdentity') private readonly identities: Model<FederatedIdentity>,
  ) {}

  findByProvider(provider: string, providerId: string): Promise<FederatedIdentity | null> {
    return this.identities.findOne({ provider, providerId }).lean<FederatedIdentity>().exec();
  }

  /** Link an external identity to an existing user. Duplicate provider+providerId → DuplicateError. */
  async link(input: {
    userId: string;
    provider: string;
    providerId: string;
    email?: string;
    emailVerified?: boolean;
  }): Promise<FederatedIdentity> {
    const doc = await mapDuplicate('FederatedIdentity', () =>
      this.identities.create({ ...input, userId: new Types.ObjectId(input.userId) }),
    );
    return doc.toObject();
  }
}
