import type { ConfigService } from '@nestjs/config';
import type { Model } from 'mongoose';
import { toAdminError } from '../admin/admin.mappers';
import { AdminAuthError } from '../identity/tenant-context/admin-auth.errors';
import type { TenantContext } from '../identity/tenant-context/tenant-context';
import { type Client, ClientService, ConcurrentClientUpdateError } from './client.service';

/** DEBT-161: the `disabledAt` stamp after the main update must report what the DB really holds. */
describe('ClientService.updateForTenant disable stamp (DEBT-161)', () => {
  const ctx = { tenantId: 't1', userId: 'u1', sessionRef: 's1' } as unknown as TenantContext;
  const superAdmin = { roles: ['super_admin'] };
  const before = {
    clientId: 'c1',
    clientType: 'confidential',
    tokenEndpointAuthMethod: 'client_secret_basic',
    redirectUris: [],
    postLogoutRedirectUris: [],
    allowedCorsOrigins: [],
    allowedResources: [],
    scopes: [],
    tenantId: 't1',
    disabledAt: null,
  } as unknown as Client;
  const cfg = {
    getOrThrow: () => ({ nodeEnv: 'test', issuer: 'http://localhost:4000' }),
  } as unknown as ConfigService;

  function setup(matchedCount: number, reread: Partial<Client> | null) {
    const calls = { updateOne: 0, findOne: 0 };
    const model = {
      findOneAndUpdate: () => ({ lean: () => ({ exec: async () => ({ ...before }) }) }),
      updateOne: () => ({
        exec: async () => {
          calls.updateOne++;
          return { matchedCount };
        },
      }),
      findOne: () => ({
        lean: () => ({
          exec: async () => {
            calls.findOne++;
            return reread && { ...before, ...reread };
          },
        }),
      }),
    } as unknown as Model<Client>;
    return { svc: new ClientService(model, cfg), calls };
  }

  it('stamp matched => disabledAt is the stamped time, no re-read', async () => {
    const { svc, calls } = setup(1, null);
    const res = await svc.updateForTenant(ctx, 'c1', { disabled: true }, superAdmin);
    expect(res!.after.disabledAt).toBeInstanceOf(Date);
    expect(calls).toEqual({ updateOne: 1, findOne: 0 });
  });

  it('stamp missed, DB already disabled by a concurrent PATCH => the DB time is returned', async () => {
    const t = new Date('2026-01-02T03:04:05Z');
    const { svc, calls } = setup(0, { disabledAt: t });
    const res = await svc.updateForTenant(ctx, 'c1', { disabled: true }, superAdmin);
    expect(res!.after.disabledAt).toBe(t);
    expect(calls).toEqual({ updateOne: 1, findOne: 1 });
  });

  it('stamp missed, DB still enabled (concurrent enable / admin grant) => ConcurrentClientUpdateError (409)', async () => {
    const { svc } = setup(0, { disabledAt: null });
    const err = await svc
      .updateForTenant(ctx, 'c1', { disabled: true }, superAdmin)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConcurrentClientUpdateError);
    const mapped = toAdminError(err);
    expect(mapped).toBeInstanceOf(AdminAuthError);
    expect((mapped as AdminAuthError).status).toBe(409);
  });

  it('stamp missed and the client vanished => 409, never a reported disable', async () => {
    const { svc } = setup(0, null);
    await expect(svc.updateForTenant(ctx, 'c1', { disabled: true }, superAdmin)).rejects.toThrow(
      ConcurrentClientUpdateError,
    );
  });
});
