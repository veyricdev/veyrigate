import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, QueryFilter } from 'mongoose';
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '../../identity/tenant-context/tenant-context';
import { ALERT_ACTIONS, type AuditAction } from './audit-action.enum';
import type { AuditAlertListener, AuditEvent, AuditEventInput, AuditMetadata } from './audit.types';

/** Runtime guard (defense in depth for `any`/casts): key names that look secret. */
const SECRET_KEY_PATTERN = /password|secret|token|privatekey|cookie|authorization|verifier/;
const SECRET_KEY_EXACT = new Set(['code', 'authorizationcode']);

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
  return SECRET_KEY_EXACT.has(normalized) || SECRET_KEY_PATTERN.test(normalized);
}

/** Drop secret-looking keys and any non-primitive values. */
export function sanitizeMetadata(metadata: AuditMetadata | undefined): AuditMetadata | undefined {
  if (!metadata) {
    return undefined;
  }
  const clean: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    if (isSecretKey(key)) {
      continue;
    }
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      clean[key] = value as string | number | boolean | null;
    }
  }
  return clean as AuditMetadata;
}

/** Exact-match filters of the admin audit query (B6.3b). Never a regex. */
export interface AuditQuery {
  action?: AuditAction;
  actorId?: string;
  targetType?: string;
  targetId?: string;
  clientId?: string;
  result?: 'success' | 'failure';
  /** Inclusive lower bound. */
  from?: Date;
  /** Exclusive upper bound. */
  to?: Date;
}

/** Position after the last event of a page (sort `timestamp desc, eventId desc`). */
export interface AuditCursor {
  timestamp: Date;
  eventId: string;
}

/**
 * Audit log (B1.7, INV-25). `record()` persists the event and throws if the
 * write fails — a sensitive operation must not silently lose its audit trail.
 * Alert actions additionally notify registered listeners (B7.2 wires Prometheus/
 * alerting); listener failures are logged and never break `record()`.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private readonly alertListeners: AuditAlertListener[] = [];

  constructor(@InjectModel('AuditLog') private readonly auditModel: Model<AuditEvent>) {}

  onAlert(listener: AuditAlertListener): void {
    this.alertListeners.push(listener);
  }

  /**
   * Admin query (B6.3b): events of the token's tenant ONLY (`tenantId` merged last, so no filter
   * can widen it; events without a tenant never match), newest first, strictly after `cursor`.
   * Stable under concurrent writes: new events sort before any cursor already handed out.
   */
  listForTenant(
    ctx: TenantContext,
    q: AuditQuery,
    cursor: AuditCursor | undefined,
    limit: number,
  ): Promise<AuditEvent[]> {
    if (!ctx?.tenantId) throw new Error('TenantContext required');
    const filter: QueryFilter<AuditEvent> = {};
    for (const key of [
      'action',
      'actorId',
      'targetType',
      'targetId',
      'clientId',
      'result',
    ] as const) {
      if (q[key] !== undefined) filter[key] = q[key];
    }
    if (q.from !== undefined || q.to !== undefined) {
      filter.timestamp = {
        ...(q.from !== undefined ? { $gte: q.from } : {}),
        ...(q.to !== undefined ? { $lt: q.to } : {}),
      };
    }
    if (cursor) {
      filter.$or = [
        { timestamp: { $lt: cursor.timestamp } },
        { timestamp: cursor.timestamp, eventId: { $lt: cursor.eventId } },
      ];
    }
    filter.tenantId = ctx.tenantId;
    return this.auditModel
      .find(filter)
      .sort({ timestamp: -1, eventId: -1 })
      .limit(limit)
      .lean<AuditEvent[]>()
      .exec();
  }

  async record(input: AuditEventInput): Promise<AuditEvent> {
    const event: AuditEvent = {
      ...input,
      metadata: sanitizeMetadata(input.metadata),
      eventId: randomUUID(),
      timestamp: new Date(),
    };
    await this.auditModel.create(event);

    if (ALERT_ACTIONS.has(event.action)) {
      this.logger.warn(
        { alert: true, action: event.action, eventId: event.eventId },
        'audit alert',
      );
      for (const listener of this.alertListeners) {
        try {
          await listener(event);
        } catch (err) {
          this.logger.error(`audit alert listener failed: ${(err as Error).message}`);
        }
      }
    }
    return event;
  }
}
