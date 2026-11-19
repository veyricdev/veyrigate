import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import type { Model } from 'mongoose';
import { registry } from '../../../common/metrics/metrics';
import { AuditAlertWatch } from './audit-alert-watch';
import type { AuditEvent } from './audit.types';

type Row = { _id: string; ts: Date | null };
type AggregateFn = (pipeline: unknown[], options: unknown) => Promise<Row[]>;

const gauge = async (action: string): Promise<number | undefined> => {
  const metric = registry.getSingleMetric('sso_audit_alert_last_event_timestamp_seconds');
  if (!metric) throw new Error('gauge not registered');
  return (await metric.get()).values.find((v) => v.labels.action === action)?.value;
};

function makeWatch(aggregate: jest.Mock<AggregateFn>) {
  return new AuditAlertWatch({ aggregate } as unknown as Model<AuditEvent>);
}

describe('AuditAlertWatch (run 97 T5, DEBT-618, D97.19)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('both gauges start at 0', async () => {
    expect(await gauge('ADMIN_RECOVERED')).toBe(0);
    expect(await gauge('ADMIN_BOOTSTRAPPED')).toBe(0);
  });

  it('one $max aggregate over the action index => each gauge set to the newest timestamp in seconds', async () => {
    const aggregate = jest.fn<AggregateFn>().mockResolvedValue([
      { _id: 'ADMIN_RECOVERED', ts: new Date('2030-01-02T03:04:05.999Z') },
      { _id: 'ADMIN_BOOTSTRAPPED', ts: new Date('2029-12-31T00:00:00.000Z') },
    ]);
    await makeWatch(aggregate).poll();
    expect(aggregate).toHaveBeenCalledWith(
      [
        { $match: { action: { $in: ['ADMIN_RECOVERED', 'ADMIN_BOOTSTRAPPED'] } } },
        { $group: { _id: '$action', ts: { $max: '$timestamp' } } },
      ],
      { maxTimeMS: 5000 },
    );
    expect(await gauge('ADMIN_RECOVERED')).toBe(Date.UTC(2030, 0, 2, 3, 4, 5) / 1000);
    expect(await gauge('ADMIN_BOOTSTRAPPED')).toBe(Date.UTC(2029, 11, 31) / 1000);
  });

  it('aggregate rejects => no throw, gauges keep their value, warn names only the error class', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const before = await gauge('ADMIN_RECOVERED');
    const aggregate = jest
      .fn<AggregateFn>()
      .mockRejectedValue(
        Object.assign(new Error('host db-7 user x'), { name: 'MongoServerError' }),
      );
    await expect(makeWatch(aggregate).poll()).resolves.toBeUndefined();
    expect(await gauge('ADMIN_RECOVERED')).toBe(before);
    expect(warn).toHaveBeenCalledWith('audit alert poll failed: MongoServerError');
  });

  it('an unknown action or a null timestamp in the result changes nothing', async () => {
    const before = await gauge('ADMIN_BOOTSTRAPPED');
    const aggregate = jest.fn<AggregateFn>().mockResolvedValue([
      { _id: 'TOKEN_ISSUED', ts: new Date() },
      { _id: 'ADMIN_BOOTSTRAPPED', ts: null },
    ]);
    await makeWatch(aggregate).poll();
    expect(await gauge('ADMIN_BOOTSTRAPPED')).toBe(before);
    expect(await registry.metrics()).not.toContain('action="TOKEN_ISSUED"} 1');
  });

  it('a tick while the previous poll is still running is skipped', async () => {
    let release: (rows: Row[]) => void = () => undefined;
    const aggregate = jest
      .fn<AggregateFn>()
      .mockImplementationOnce(() => new Promise<Row[]>((r) => (release = r)))
      .mockResolvedValue([]);
    const watch = makeWatch(aggregate);
    const first = watch.poll();
    await watch.poll();
    expect(aggregate).toHaveBeenCalledTimes(1);
    release([]);
    await first;
    await watch.poll();
    expect(aggregate).toHaveBeenCalledTimes(2);
  });

  it('bootstrap polls once and every 60 s (unref timer); destroy stops it', async () => {
    jest.useFakeTimers();
    try {
      const aggregate = jest.fn<AggregateFn>().mockResolvedValue([]);
      const watch = makeWatch(aggregate);
      watch.onApplicationBootstrap();
      expect(aggregate).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(aggregate).toHaveBeenCalledTimes(2);
      watch.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(180_000);
      expect(aggregate).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
