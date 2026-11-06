import { Schema } from 'mongoose';
import { AuditAction } from './audit-action.enum';

/** Default audit retention (run 71, DEBT-344, plan §12): `AUDIT_RETENTION_DAYS` unset or empty. */
export const DEFAULT_AUDIT_RETENTION_DAYS = 180;

/**
 * AuditLog (spec §10). Never contains password/token/secret values (INV-20, INV-25).
 * A NEW schema per call (never mutate a shared one): the TTL comes from `AUDIT_RETENTION_DAYS`.
 */
export function createAuditLogSchema(retentionDays: number): Schema {
  const schema = new Schema(
    {
      eventId: { type: String, required: true },
      timestamp: { type: Date, required: true },
      actorType: { type: String, required: true, enum: ['user', 'client', 'admin', 'system'] },
      actorId: { type: String },
      tenantId: { type: String },
      action: { type: String, required: true, enum: Object.values(AuditAction) },
      targetType: { type: String },
      targetId: { type: String },
      clientId: { type: String },
      ip: { type: String },
      userAgent: { type: String },
      requestId: { type: String },
      result: { type: String, required: true, enum: ['success', 'failure'] },
      reason: { type: String },
      metadata: { type: Schema.Types.Mixed },
    },
    { versionKey: false },
  );
  // Run 71 (DEBT-344): TTL on the existing `timestamp_1` index (no new field, no backfill). An
  // existing DB is switched in place by `collMod` in `syncAllIndexes` (never drop + rebuild).
  schema.index({ timestamp: 1 }, { expireAfterSeconds: retentionDays * 86400 });
  schema.index({ actorId: 1 }); // spec §10 "index(userId)" — the user is the actor
  schema.index({ clientId: 1 });
  schema.index({ action: 1 });
  // B6.3b: admin audit query = one tenant, newest first, cursor `(timestamp, _id)` (run 57,
  // DEBT-422; replaces `{tenantId, timestamp, eventId}`: deploy runs `db:sync-indexes`).
  schema.index({ tenantId: 1, timestamp: -1, _id: -1 });
  return schema;
}
