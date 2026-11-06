import { Schema } from 'mongoose';

/** UserTenant membership (spec §10). */
export const UserTenantSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  tenantId: { type: String, required: true },
  status: { type: String, required: true, enum: ['active', 'suspended'], default: 'active' },
  roles: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now },
  // DEBT-142: write-conflict counter `$inc`ed by `SuperAdminGuard` inside its transaction. MUST be
  // declared: `strict` strips an unknown path from the update, leaving no write and no conflict.
  // Never returned to a client.
  superAdminGuard: { type: Number },
});
UserTenantSchema.index({ userId: 1, tenantId: 1 }, { unique: true });
// DEBT-142: the guard's per-tenant super_admin lookup (no COLLSCAN inside the transaction).
UserTenantSchema.index({ tenantId: 1, roles: 1 });
