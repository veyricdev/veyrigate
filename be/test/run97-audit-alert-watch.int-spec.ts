import { randomBytes } from 'node:crypto';
import type { Model } from 'mongoose';
import { AuditAction } from '../src/modules/security/audit/audit-action.enum';
import { AuditAlertWatch } from '../src/modules/security/audit/audit-alert-watch';
import { AuditService } from '../src/modules/security/audit/audit.service';
import { bootFullApp, type FullApp } from './full-app';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';

/**
 * Run 97 T5 (DEBT-618, D97.19/D97.21) on the REAL app + int DB: an `ADMIN_RECOVERED` event (written like
 * the CLI does, through `AuditService.record`) reaches `/metrics` as the newest-timestamp gauge after one
 * poll, and the poll's aggregate runs on the existing `action_1` index (no new index).
 */
// Random per run, never printed (a 64-char hex value satisfies METRICS_TOKEN min(32)).
const METRICS_TOKEN = randomBytes(32).toString('hex');
const PIPELINE = [
  { $match: { action: { $in: ['ADMIN_RECOVERED', 'ADMIN_BOOTSTRAPPED'] } } },
  { $group: { _id: '$action', ts: { $max: '$timestamp' } } },
];

describe('run 97 T5: ADMIN_RECOVERED is polled into a gauge', () => {
  let full: FullApp;

  let setup: Promise<void> | undefined;
  beforeAll(
    () =>
      (setup = (async () => {
        full = await bootFullApp({ name: 'run97aw', env: { METRICS_TOKEN } });
      })()),
    INT_SETUP_TIMEOUT_MS,
  );
  afterAll(async () => {
    await settled(setup);
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);

  const gauge = async (action: string): Promise<number> => {
    const res = await full.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const m = new RegExp(
      `^sso_audit_alert_last_event_timestamp_seconds\\{action="${action}"\\} (\\S+)$`,
      'm',
    ).exec(res.body);
    expect(m).not.toBeNull();
    return Number(m![1]);
  };

  it('record ADMIN_RECOVERED, poll => /metrics gauge = its timestamp in seconds; BOOTSTRAPPED stays 0', async () => {
    const watch = full.app.get(AuditAlertWatch);
    await watch.poll(); // empty DB: nothing to set
    expect(await gauge('ADMIN_RECOVERED')).toBe(0);
    const at = new Date(Date.now() - 120_000);
    await full.app
      .get(AuditService)
      .record(
        { actorType: 'system', action: AuditAction.ADMIN_RECOVERED, result: 'success' },
        { timestamp: at },
      );
    await watch.poll();
    expect(await gauge('ADMIN_RECOVERED')).toBe(Math.floor(at.getTime() / 1000));
    expect(await gauge('ADMIN_BOOTSTRAPPED')).toBe(0);
  });

  it('the poll aggregate uses the existing action_1 index (IXSCAN), never a collection scan', async () => {
    const auditModel = full.conn.model('AuditLog') as Model<unknown>;
    const plan = JSON.stringify(await auditModel.aggregate(PIPELINE).explain('queryPlanner'));
    expect(plan).toContain('IXSCAN');
    expect(plan).toContain('"indexName":"action_1"');
    expect(plan).not.toContain('COLLSCAN');
  });
});
