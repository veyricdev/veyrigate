import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AUDIT_ALERT_WATCHED, setAuditAlertLastEvent } from '../../../common/metrics/metrics';
import type { AuditEvent } from './audit.types';

const POLL_MS = 60_000;

/**
 * Run 97 (DEBT-618, D97.18/D97.19): `ADMIN_RECOVERED` / `ADMIN_BOOTSTRAPPED` are written by CLIs, where
 * no app alert listener runs. Every 60 s the app reads the newest timestamp of each (one `$max`
 * aggregate on the existing `{action:1}` index) into a gauge, and Prometheus alerts while it is
 * younger than 30 min. Stateless (no change stream, no resume token): safe across restarts and
 * replicas. A failed poll keeps the previous values and only logs the error class.
 */
@Injectable()
export class AuditAlertWatch implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AuditAlertWatch.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(@InjectModel('AuditLog') private readonly auditModel: Model<AuditEvent>) {}

  onApplicationBootstrap(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS).unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async poll(): Promise<void> {
    if (this.running) return; // never stack polls behind a slow Mongo
    this.running = true;
    try {
      const rows = await this.auditModel.aggregate<{ _id: string; ts: Date | null }>(
        [
          { $match: { action: { $in: [...AUDIT_ALERT_WATCHED] } } },
          { $group: { _id: '$action', ts: { $max: '$timestamp' } } },
        ],
        { maxTimeMS: 5000 },
      );
      for (const { _id, ts } of rows) {
        if (ts instanceof Date) setAuditAlertLastEvent(_id, Math.floor(ts.getTime() / 1000));
      }
    } catch (err) {
      this.logger.warn(`audit alert poll failed: ${(err as Error).name}`);
    } finally {
      this.running = false;
    }
  }
}
