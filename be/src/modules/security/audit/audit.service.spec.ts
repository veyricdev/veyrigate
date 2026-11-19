import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import type { Model } from 'mongoose';
import { registry } from '../../../common/metrics/metrics';
import { AuditAction } from './audit-action.enum';
import { AuditService, sanitizeMetadata } from './audit.service';
import type { AuditEvent, AuditMetadata } from './audit.types';

type CreateFn = (doc: unknown) => Promise<unknown>;

/** Current value of one series (undefined when it does not exist). */
async function metricValue(
  name: string,
  labels: Record<string, string>,
): Promise<number | undefined> {
  const metric = registry.getSingleMetric(name);
  if (!metric) throw new Error(`metric ${name} not registered`);
  const { values } = await metric.get();
  return values.find((v) => Object.entries(labels).every(([k, w]) => String(v.labels[k]) === w))
    ?.value;
}

function makeService(create: jest.Mock<CreateFn> = jest.fn<CreateFn>().mockResolvedValue({})) {
  const model = { create } as unknown as Model<AuditEvent>;
  return { service: new AuditService(model), create };
}

describe('AuditService (B1.7, INV-25)', () => {
  it('forbidden metadata keys do not compile', () => {
    // @ts-expect-error — `password` is typed `never`
    const a: AuditMetadata = { password: 'x' };
    // @ts-expect-error — `refresh_token` is typed `never`
    const b: AuditMetadata = { refresh_token: 'x' };
    // @ts-expect-error — `clientSecret` is typed `never`
    const c: AuditMetadata = { clientSecret: 'x' };
    // @ts-expect-error — nested objects are not allowed
    const d: AuditMetadata = { nested: { token: 'x' } };
    expect([a, b, c, d]).toHaveLength(4);
  });

  it('strips secret-looking keys and non-primitive values at runtime', () => {
    const dirty = {
      password: 'p',
      Access_Token: 'a',
      client_secret: 's',
      Authorization: 'Bearer x',
      codeVerifier: 'v',
      code: 'c',
      privateKey: 'k',
      nested: { token: 't' },
      mode: 'normal',
      attempts: 3,
      ok: true,
      oldKid: null,
    } as unknown as AuditMetadata;
    expect(sanitizeMetadata(dirty)).toEqual({
      mode: 'normal',
      attempts: 3,
      ok: true,
      oldKid: null,
    });
  });

  it('persists the sanitized event with eventId + timestamp', async () => {
    const { service, create } = makeService();
    const event = await service.record({
      actorType: 'user',
      actorId: 'u1',
      action: AuditAction.AUTH_LOGIN_FAILED,
      result: 'failure',
      metadata: { reason: 'bad', token: 'leak' } as unknown as AuditMetadata,
    });
    const saved = create.mock.calls[0][0] as AuditEvent;
    expect(saved.metadata).toEqual({ reason: 'bad' });
    expect(JSON.stringify(saved)).not.toContain('leak');
    expect(saved.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.timestamp).toBeInstanceOf(Date);
    expect(event.eventId).toBe(saved.eventId);
  });

  it('throws when the audit write fails (no silent loss)', async () => {
    const { service } = makeService(jest.fn<CreateFn>().mockRejectedValue(new Error('mongo down')));
    await expect(
      service.record({ actorType: 'system', action: AuditAction.TOKEN_REVOKED, result: 'success' }),
    ).rejects.toThrow('mongo down');
  });

  it('fires alert listeners only for alert actions; a failing listener does not break record()', async () => {
    const { service } = makeService();
    const seen: string[] = [];
    service.onAlert(() => {
      throw new Error('listener boom');
    });
    service.onAlert((e) => {
      seen.push(e.action);
    });

    await service.record({
      actorType: 'user',
      action: AuditAction.AUTH_LOGIN_SUCCESS,
      result: 'success',
    });
    await service.record({
      actorType: 'system',
      action: AuditAction.TOKEN_REUSE_DETECTED,
      result: 'failure',
    });
    await service.record({
      actorType: 'admin',
      action: AuditAction.SIGNING_KEY_ROTATED,
      result: 'success',
    });

    expect(seen).toEqual([AuditAction.TOKEN_REUSE_DETECTED, AuditAction.SIGNING_KEY_ROTATED]);
  });

  it('run 57: opts.timestamp is used as the event timestamp (eventId still random)', async () => {
    const { service, create } = makeService();
    const at = new Date('2030-01-02T03:04:05.006Z');
    const event = await service.record(
      { actorType: 'admin', action: AuditAction.ADMIN_USER_LOCKED, result: 'success' },
      { timestamp: at },
    );
    const saved = create.mock.calls[0][0] as AuditEvent;
    expect(saved.timestamp.getTime()).toBe(at.getTime());
    expect(event.timestamp.getTime()).toBe(at.getTime());
    expect(saved.eventId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('run 57: an invalid opts.timestamp rejects and writes nothing', async () => {
    const { service, create } = makeService();
    for (const bad of [new Date(Number.NaN), 'x' as unknown as Date, 0 as unknown as Date]) {
      await expect(
        service.record(
          { actorType: 'admin', action: AuditAction.ADMIN_USER_LOCKED, result: 'success' },
          { timestamp: bad },
        ),
      ).rejects.toThrow('invalid audit timestamp');
    }
    expect(create).not.toHaveBeenCalled();
  });

  describe('run 97 T3 (DEBT-218, D97.2): counters do not depend on the audit write', () => {
    const reuse = { action: AuditAction.TOKEN_REUSE_DETECTED };

    afterEach(() => jest.restoreAllMocks());

    it('write fails: record rejects, the event and the write failure are both counted, the log has no metadata', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const events0 = (await metricValue('sso_audit_events_total', {
        ...reuse,
        result: 'failure',
      }))!;
      const fails0 = (await metricValue('sso_audit_write_failures_total', reuse))!;
      const { service } = makeService(
        jest
          .fn<CreateFn>()
          .mockRejectedValue(new Error('E11000 dup key { familyId: "fam-secret" }')),
      );
      await expect(
        service.record({
          actorType: 'system',
          action: AuditAction.TOKEN_REUSE_DETECTED,
          result: 'failure',
          metadata: { familyId: 'fam-secret' },
        }),
      ).rejects.toThrow('E11000');
      expect(await metricValue('sso_audit_events_total', { ...reuse, result: 'failure' })).toBe(
        events0 + 1,
      );
      expect(await metricValue('sso_audit_write_failures_total', reuse)).toBe(fails0 + 1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [obj, msg] = errorSpy.mock.calls[0] as [Record<string, unknown>, string];
      expect(msg).toBe('audit write failed');
      expect(obj).toEqual({
        alert: true,
        action: AuditAction.TOKEN_REUSE_DETECTED,
        eventId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        auditWriteFailed: true,
      });
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('fam-secret');
    });

    it('write fails for a non-alert action: alert false, no audit alert line, listeners not called', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { service } = makeService(jest.fn<CreateFn>().mockRejectedValue(new Error('down')));
      const listener = jest.fn<() => void>();
      service.onAlert(listener);
      await expect(
        service.record({ actorType: 'user', action: AuditAction.TOKEN_ISSUED, result: 'success' }),
      ).rejects.toThrow('down');
      expect(warnSpy).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
    });

    it('write OK: the write failure counter does not move', async () => {
      const fails0 = (await metricValue('sso_audit_write_failures_total', reuse))!;
      const events0 = (await metricValue('sso_audit_events_total', {
        ...reuse,
        result: 'failure',
      }))!;
      const { service } = makeService();
      await service.record({
        actorType: 'system',
        action: AuditAction.TOKEN_REUSE_DETECTED,
        result: 'failure',
      });
      expect(await metricValue('sso_audit_write_failures_total', reuse)).toBe(fails0);
      expect(await metricValue('sso_audit_events_total', { ...reuse, result: 'failure' })).toBe(
        events0 + 1,
      );
    });
  });
});
