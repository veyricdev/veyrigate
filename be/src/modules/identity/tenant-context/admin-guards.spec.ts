import { jest } from '@jest/globals';
import { type ArgumentsHost, Controller, Get, Logger, UseFilters, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { registry } from '../../../common/metrics/metrics';
import { RedisService } from '../../../database/redis/redis.service';
import { ClientService } from '../../clients/client.service';
import { TokenVerifier } from '../../keys/token-verifier';
import { adminResourceIdentifier } from '../../oauth/token/token.service';
import { ResourceService } from '../../resources/resource.service';
import { AuditAction } from '../../security/audit/audit-action.enum';
import { AuditService } from '../../security/audit/audit.service';
import { RateLimitService } from '../../security/rate-limit/rate-limit.service';
import { SessionService } from '../../sessions/session.service';
import { UserTenantService } from '../user-tenant.service';
import { AdminAuthError, AdminAuthErrorFilter } from './admin-auth.errors';
import {
  AdminScope,
  AdminTokenGuard,
  RequireRecentAuth,
  STEP_UP_CLOCK,
  SuperAdminOnly,
  Tenant,
  type TenantContext,
} from './tenant-context';

const ISSUER = 'http://localhost:4000';
const ADMIN_AUD = adminResourceIdentifier(ISSUER);
const SUB = new Types.ObjectId().toHexString();
const NOW_SEC = 1_800_000_000;

@Controller('t')
@UseGuards(AdminTokenGuard)
@UseFilters(AdminAuthErrorFilter)
class ProbeController {
  @Get('step-up')
  @AdminScope('admin.read')
  @RequireRecentAuth(5)
  stepUp(@Tenant() ctx: TenantContext) {
    return { tenantId: ctx.tenantId };
  }

  @Get('write')
  @AdminScope('admin.write')
  write() {
    return { ok: true };
  }

  @Get('super')
  @AdminScope('admin.read')
  @SuperAdminOnly()
  @RequireRecentAuth(5)
  superOnly(@Tenant() ctx: TenantContext) {
    return { tenantId: ctx.tenantId };
  }
}

/**
 * Unit level (no Mongo/Redis): the B6.2 step-up rules behind a stubbed B6.1 guard. The real-DB
 * chain (/authorize -> /login -> /token) is in `test/admin.int-spec.ts`.
 */
describe('StepUpGuard (B6.2) behind AdminTokenGuard (unit, stubbed collaborators)', () => {
  let app: NestFastifyApplication;
  let claims: Record<string, unknown>;
  let nowMs = NOW_SEC * 1000;
  let roles = ['tenant_admin'];
  let ended = false;
  let clientType = 'confidential';
  let verifyFails = false;
  const record = jest.fn<(e: unknown) => Promise<unknown>>().mockResolvedValue({});
  const redisKeys = new Set<string>();
  const redisSet = jest.fn(async (key: string, ..._args: unknown[]) => {
    if (redisKeys.has(key)) return null;
    redisKeys.add(key);
    return 'OK';
  });
  const redisDel = jest.fn(async (key: string) => Number(redisKeys.delete(key)));
  const findByClientId = jest.fn(async (_id: string) => ({
    allowedResources: ['admin'],
    tenantId: 'tenant-A',
    clientType,
    tokenEndpointAuthMethod: 'client_secret_basic',
  }));
  const hit = jest
    .fn<(r: unknown, s: unknown) => Promise<{ allowed: boolean }>>()
    .mockResolvedValue({ allowed: true });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        {
          provide: TokenVerifier,
          useValue: {
            verifyAccessToken: async () => {
              if (verifyFails) throw new Error('bad signature');
              return claims;
            },
          },
        },
        { provide: AuditService, useValue: { record } },
        { provide: RedisService, useValue: { client: { set: redisSet, del: redisDel } } },
        { provide: RateLimitService, useValue: { hit } },
        { provide: ClientService, useValue: { findByClientId } },
        { provide: ResourceService, useValue: { identifiersFor: async () => [ADMIN_AUD] } },
        {
          provide: SessionService,
          useValue: { isEnded: async () => ended, isAccessTokenRevoked: async () => false },
        },
        { provide: UserTenantService, useValue: { activeRoles: async () => roles } },
        { provide: getModelToken('User'), useValue: { exists: async () => ({ _id: SUB }) } },
        { provide: ConfigService, useValue: { getOrThrow: () => ({ issuer: ISSUER }) } },
        { provide: STEP_UP_CLOCK, useValue: () => nowMs },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(() => app.close());

  const call = async (authTime: unknown, now = NOW_SEC * 1000, url = '/t/step-up') => {
    nowMs = now;
    claims = {
      sub: SUB,
      aud: ADMIN_AUD,
      client_id: 'c',
      scope: 'admin.read',
      sid: 'a'.repeat(64),
      ...(authTime !== undefined ? { auth_time: authTime } : {}),
    };
    return app.inject({ method: 'GET', url, headers: { authorization: 'Bearer x' } });
  };

  it('auth_time = now => 200', async () => {
    const res = await call(NOW_SEC);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenantId: 'tenant-A' });
  });

  it('exactly 5 min old => 200; 5 min + 1 s => 403 step_up_required, no-store', async () => {
    expect((await call(NOW_SEC - 300)).statusCode).toBe(200);
    const res = await call(NOW_SEC - 301);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'step_up_required', max_age: 0 });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('missing / string / fractional / NaN auth_time => 403', async () => {
    for (const authTime of [undefined, String(NOW_SEC), NOW_SEC - 0.5, Number.NaN, null]) {
      const res = await call(authTime);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('step_up_required');
    }
  });

  it('future auth_time: +30 s tolerated, +31 s => 403', async () => {
    expect((await call(NOW_SEC + 30)).statusCode).toBe(200);
    expect((await call(NOW_SEC + 31)).statusCode).toBe(403);
  });

  it('the injected clock decides staleness (same token, later clock => 403)', async () => {
    expect((await call(NOW_SEC, NOW_SEC * 1000)).statusCode).toBe(200);
    expect((await call(NOW_SEC, (NOW_SEC + 301) * 1000)).statusCode).toBe(403);
  });

  it('B6.1 failure wins over step-up: wrong aud => 401 even with a fresh auth_time', async () => {
    nowMs = NOW_SEC * 1000;
    claims = {
      sub: SUB,
      aud: 'http://localhost:4000/demo/',
      client_id: 'c',
      scope: 'admin.read',
      sid: 'a'.repeat(64),
      auth_time: NOW_SEC,
    };
    const res = await app.inject({
      method: 'GET',
      url: '/t/step-up',
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(401);
  });

  describe('DEBT-325: @SuperAdminOnly() is checked in AdminTokenGuard, before StepUpGuard', () => {
    afterEach(() => {
      roles = ['tenant_admin'];
    });

    it('tenant_admin with a stale auth_time => 403 forbidden (never step_up_required)', async () => {
      const res = await call(NOW_SEC - 301, NOW_SEC * 1000, '/t/super');
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden' });
    });

    it('tenant_admin with a fresh auth_time => 403 forbidden', async () => {
      const res = await call(NOW_SEC, NOW_SEC * 1000, '/t/super');
      expect(res.json()).toEqual({ error: 'forbidden' });
    });

    it('super_admin: fresh => 200; stale => step_up_required', async () => {
      roles = ['super_admin'];
      expect((await call(NOW_SEC, NOW_SEC * 1000, '/t/super')).statusCode).toBe(200);
      const stale = await call(NOW_SEC - 301, NOW_SEC * 1000, '/t/super');
      expect(stale.json()).toEqual({ error: 'step_up_required', max_age: 0 });
    });

    it('a route without the metadata keeps its order (tenant_admin stale => step_up_required)', async () => {
      const res = await call(NOW_SEC - 301);
      expect(res.json().error).toBe('step_up_required');
    });
  });

  describe('run 97 T2 (DEBT-126, D97.8/D97.9): audit of a refused admin token', () => {
    let warn: jest.SpiedFunction<Logger['warn']>;
    beforeEach(() => {
      record.mockClear().mockResolvedValue({});
      redisSet.mockClear();
      redisDel.mockClear();
      findByClientId.mockClear();
      redisKeys.clear();
      hit.mockClear().mockResolvedValue({ allowed: true });
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => {
      jest.restoreAllMocks();
      roles = ['tenant_admin'];
      ended = false;
      clientType = 'confidential';
      verifyFails = false;
    });

    const lastEvent = () => record.mock.calls.at(-1)![0] as Record<string, unknown>;

    it('bad signature => 401, nothing audited, Redis untouched', async () => {
      verifyFails = true;
      const res = await call(NOW_SEC);
      expect(res.statusCode).toBe(401);
      expect(record).not.toHaveBeenCalled();
      expect(redisSet).not.toHaveBeenCalled();
    });

    it('no bearer => 401, nothing audited', async () => {
      const res = await app.inject({ method: 'GET', url: '/t/step-up' });
      expect(res.statusCode).toBe(401);
      expect(record).not.toHaveBeenCalled();
    });

    it('not live (logged out) => 401 + one ADMIN_ACCESS_DENIED not_live; the session check runs before the client lookup, so the audit looks the client up to fill the tenant (DEBT-707); a second refusal of the same sub is deduped', async () => {
      ended = true;
      const res = await call(NOW_SEC);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid_token' });
      expect(record).toHaveBeenCalledTimes(1);
      expect(findByClientId).toHaveBeenCalledWith('c');
      expect(lastEvent()).toEqual({
        actorType: 'user',
        actorId: SUB,
        clientId: 'c',
        tenantId: 'tenant-A',
        action: AuditAction.ADMIN_ACCESS_DENIED,
        result: 'failure',
        metadata: { reason: 'not_live', method: 'GET', route: '/t/step-up' },
      });
      expect(redisSet).toHaveBeenCalledWith(
        expect.stringMatching(/^adm_deny:\{[0-9a-f]{64}\}:not_live$/),
        '1',
        'EX',
        900,
        'NX',
      );
      expect(JSON.stringify(redisSet.mock.calls)).not.toContain(SUB);
      const lookups = findByClientId.mock.calls.length;
      expect((await call(NOW_SEC)).statusCode).toBe(401);
      expect(record).toHaveBeenCalledTimes(1);
      expect(findByClientId).toHaveBeenCalledTimes(lookups); // deduped => no audit lookup
      expect(redisDel).not.toHaveBeenCalled();
      expect(hit).toHaveBeenCalledTimes(1);
      expect(hit).toHaveBeenCalledWith(
        { name: 'admin-deny-audit', limit: 60, windowSec: 60 },
        { account: 'global' },
      );
    });

    it('wrong audience => 401 + wrong_audience (no tenant: the client was never loaded)', async () => {
      claims = {
        sub: SUB,
        aud: 'http://localhost:4000/demo/',
        client_id: 'c',
        scope: 'x',
        sid: 's',
      };
      const res = await app.inject({
        method: 'GET',
        url: '/t/step-up',
        headers: { authorization: 'Bearer x' },
      });
      expect(res.statusCode).toBe(401);
      expect(lastEvent()).toEqual(
        expect.objectContaining({
          actorId: SUB,
          metadata: expect.objectContaining({ reason: 'wrong_audience' }),
        }),
      );
      expect(lastEvent()).not.toHaveProperty('tenantId');
    });

    it('client no longer admin-capable => 401; liveness refuses it first (DEBT-177), so the reason is not_live with the tenant', async () => {
      clientType = 'public';
      expect((await call(NOW_SEC)).statusCode).toBe(401);
      expect(lastEvent()).toEqual(
        expect.objectContaining({
          tenantId: 'tenant-A',
          metadata: expect.objectContaining({ reason: 'not_live' }),
        }),
      );
    });

    it('missing admin.write => 403 insufficient_scope + insufficient_scope audit', async () => {
      const res = await call(NOW_SEC, NOW_SEC * 1000, '/t/write');
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'insufficient_scope' });
      expect(lastEvent().metadata).toEqual({
        reason: 'insufficient_scope',
        method: 'GET',
        route: '/t/write',
      });
    });

    it('no admin role / not super_admin => 403 forbidden + forbidden audit', async () => {
      roles = ['member'];
      expect((await call(NOW_SEC)).statusCode).toBe(403);
      expect(lastEvent().metadata).toEqual(expect.objectContaining({ reason: 'forbidden' }));
      roles = ['tenant_admin'];
      redisKeys.clear();
      expect((await call(NOW_SEC, NOW_SEC * 1000, '/t/super')).statusCode).toBe(403);
      expect(record).toHaveBeenCalledTimes(2);
    });

    it('step_up_required is never audited', async () => {
      const res = await call(NOW_SEC - 301);
      expect(res.json().error).toBe('step_up_required');
      expect(record).not.toHaveBeenCalled();
      expect(redisSet).not.toHaveBeenCalled();
    });

    it('global cap reached => no audit, still 401, the dedupe key is released (next refusal is audited)', async () => {
      ended = true;
      hit.mockResolvedValueOnce({ allowed: false });
      expect((await call(NOW_SEC)).statusCode).toBe(401);
      expect(record).not.toHaveBeenCalled();
      expect(findByClientId).toHaveBeenCalledTimes(0); // no lookup before the cap passed
      expect(redisDel).toHaveBeenCalledWith(redisSet.mock.calls[0]![0]);
      expect((await call(NOW_SEC)).statusCode).toBe(401);
      expect(record).toHaveBeenCalledTimes(1);
    });

    it('client lookup of the not_live audit rejects => still 401, no audit, warn with the error class only, dedupe key released', async () => {
      ended = true;
      findByClientId.mockRejectedValueOnce(
        Object.assign(new Error('mongo 10.0.0.1 timeout'), { name: 'MongoServerSelectionError' }),
      );
      expect((await call(NOW_SEC)).statusCode).toBe(401);
      expect(record).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('admin deny audit skipped: MongoServerSelectionError');
      expect(redisDel).toHaveBeenCalledTimes(1);
    });

    it('Redis rejects => still 401 (never 5xx), audit skipped with a warn naming only the error class', async () => {
      ended = true;
      redisSet.mockRejectedValueOnce(
        Object.assign(new Error('ECONNREFUSED 10.0.0.1'), { name: 'ReplyError' }),
      );
      const res = await call(NOW_SEC);
      expect(res.statusCode).toBe(401);
      expect(record).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('admin deny audit skipped: ReplyError');
    });

    it('audit write rejects => still 401/403, the dedupe key is released (a retry is audited again)', async () => {
      ended = true;
      record.mockRejectedValue(new Error('mongo down'));
      expect((await call(NOW_SEC)).statusCode).toBe(401);
      ended = false;
      expect((await call(NOW_SEC, NOW_SEC * 1000, '/t/write')).statusCode).toBe(403);
      expect(record).toHaveBeenCalledTimes(2);
      expect(redisDel).toHaveBeenCalledTimes(2);
      expect((await call(NOW_SEC, NOW_SEC * 1000, '/t/write')).statusCode).toBe(403);
      expect(record).toHaveBeenCalledTimes(3);
    });

    it('Redis DEL of the dedupe key rejects => still 401, nothing thrown', async () => {
      ended = true;
      hit.mockResolvedValueOnce({ allowed: false });
      redisDel.mockRejectedValueOnce(new Error('redis down'));
      expect((await call(NOW_SEC)).statusCode).toBe(401);
      expect(redisDel).toHaveBeenCalledTimes(1);
    });
  });
});

describe('AdminAuthErrorFilter (run 97 T2, D97.7): sso_admin_auth_denied_total', () => {
  const value = async (reason: string) => {
    const { values } = await registry.getSingleMetric('sso_admin_auth_denied_total')!.get();
    return values.find((v) => v.labels.reason === reason)?.value;
  };
  const host = () => {
    const reply = { status: () => reply, header: () => reply, send: () => undefined };
    return { switchToHttp: () => ({ getResponse: () => reply }) } as unknown as ArgumentsHost;
  };

  it('the 4 reasons start at 0; 401/403 add 1 by body.error; 400/404/409 add nothing', async () => {
    const reasons = ['invalid_token', 'insufficient_scope', 'forbidden', 'step_up_required'];
    const before = await Promise.all(reasons.map(value));
    for (const b of before) expect(b).toEqual(expect.any(Number));
    const filter = new AdminAuthErrorFilter();
    filter.catch(AdminAuthError.invalidToken(), host());
    filter.catch(AdminAuthError.insufficientScope('admin.write'), host());
    filter.catch(AdminAuthError.forbidden(), host());
    filter.catch(AdminAuthError.stepUpRequired(), host());
    filter.catch(AdminAuthError.stepUpRequired(), host());
    filter.catch(AdminAuthError.notFound(), host());
    filter.catch(AdminAuthError.conflict('x'), host());
    filter.catch(AdminAuthError.invalidRequest('x'), host());
    const after = await Promise.all(reasons.map(value));
    expect(after).toEqual([before[0]! + 1, before[1]! + 1, before[2]! + 1, before[3]! + 2]);
    expect(await registry.metrics()).not.toMatch(
      /sso_admin_auth_denied_total\{reason="(not_found|conflict|invalid_request)"/,
    );
  });
});
