import { Schema } from 'mongoose';

/** Tenant (spec §10). `id` is the stable tenant identifier. */
export const TenantSchema = new Schema({
  id: { type: String, required: true },
  name: { type: String, required: true },
});
TenantSchema.index({ id: 1 }, { unique: true });
