import { Schema } from 'mongoose';
import { AuditAction } from './audit-action.enum';

/** AuditLog (spec §10). Never contains password/token/secret values (INV-20, INV-25). */
export const AuditLogSchema = new Schema(
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
AuditLogSchema.index({ timestamp: 1 });
AuditLogSchema.index({ actorId: 1 }); // spec §10 "index(userId)" — the user is the actor
AuditLogSchema.index({ clientId: 1 });
AuditLogSchema.index({ action: 1 });
