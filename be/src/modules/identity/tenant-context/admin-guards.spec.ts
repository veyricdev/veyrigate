import { Controller, Get, UseFilters, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { ClientService } from '../../clients/client.service';
import { TokenVerifier } from '../../keys/token-verifier';
import { adminResourceIdentifier } from '../../oauth/token/token.service';
import { ResourceService } from '../../resources/resource.service';
import { SessionService } from '../../sessions/session.service';
import { UserTenantService } from '../user-tenant.service';
import { AdminAuthErrorFilter } from './admin-auth.errors';
import {
  AdminScope,
  AdminTokenGuard,
  RequireRecentAuth,
  STEP_UP_CLOCK,
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
}

/**
 * Unit level (no Mongo/Redis): the B6.2 step-up rules behind a stubbed B6.1 guard. The real-DB
 * chain (/authorize -> /login -> /token) is in `test/admin.int-spec.ts`.
 */
describe('StepUpGuard (B6.2) behind AdminTokenGuard (unit, stubbed collaborators)', () => {
  let app: NestFastifyApplication;
  let claims: Record<string, unknown>;
  let nowMs = NOW_SEC * 1000;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        { provide: TokenVerifier, useValue: { verifyAccessToken: async () => claims } },
        {
          provide: ClientService,
          useValue: {
            findByClientId: async () => ({ allowedResources: ['admin'], tenantId: 'tenant-A' }),
          },
        },
        { provide: ResourceService, useValue: { identifiersFor: async () => [ADMIN_AUD] } },
        { provide: SessionService, useValue: { isEnded: async () => false } },
        { provide: UserTenantService, useValue: { activeRoles: async () => ['tenant_admin'] } },
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

  const call = async (authTime: unknown, now = NOW_SEC * 1000) => {
    nowMs = now;
    claims = {
      sub: SUB,
      aud: ADMIN_AUD,
      client_id: 'c',
      scope: 'admin.read',
      sid: 'a'.repeat(64),
      ...(authTime !== undefined ? { auth_time: authTime } : {}),
    };
    return app.inject({ method: 'GET', url: '/t/step-up', headers: { authorization: 'Bearer x' } });
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
});
