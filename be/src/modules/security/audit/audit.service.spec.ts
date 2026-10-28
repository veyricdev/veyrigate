import { jest } from '@jest/globals';
import type { Model } from 'mongoose';
import { AuditAction } from './audit-action.enum';
import { AuditService, sanitizeMetadata } from './audit.service';
import type { AuditEvent, AuditMetadata } from './audit.types';

type CreateFn = (doc: unknown) => Promise<unknown>;

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
});
