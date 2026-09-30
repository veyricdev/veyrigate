import { Schema } from 'mongoose';

/** UserTenant membership (spec §10). */
export const UserTenantSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  tenantId: { type: String, required: true },
  status: { type: String, required: true, enum: ['active', 'suspended'], default: 'active' },
  roles: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now },
});
UserTenantSchema.index({ userId: 1, tenantId: 1 }, { unique: true });
