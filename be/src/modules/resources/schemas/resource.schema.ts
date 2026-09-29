import { Schema } from 'mongoose';

/** Resource server (spec §7, §10). `identifier` is an absolute URI. */
export const ResourceSchema = new Schema({
  resourceId: { type: String, required: true },
  identifier: { type: String, required: true },
  scopes: { type: [String], default: [] },
});
ResourceSchema.index({ identifier: 1 }, { unique: true });
