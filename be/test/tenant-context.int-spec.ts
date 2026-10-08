import cookie from '@fastify/cookie';
import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import IORedis from 'ioredis';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import { MODELS } from '../src/database/mongo/models';
import { RedisService } from '../src/database/redis/redis.service';
import {
  Tenant,
  type TenantContext,
  TenantGuard,
} from '../src/modules/identity/tenant-context/tenant-context';
import { TenantScopedRepository } from '../src/modules/identity/tenant-context/tenant-scoped.repository';
import { type UserTenant, UserTenantService } from '../src/modules/identity/user-tenant.service';
import { SessionCookie } from '../src/modules/sessions/session.cookie';
import { SessionService } from '../src/modules/sessions/session.service';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';
const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-tenant-${Date.now()}?directConnection=true`;

let seenCtx: TenantContext | undefined;

@Controller()
@UseGuards(TenantGuard)
class MembersController {
  constructor(private readonly memberships: UserTenantService) {}

  @Get('members')
  list(@Tenant() ctx: TenantContext, @Query() _q: Record<string, string>) {
    seenCtx = ctx;
    return this.memberships.listMembers(ctx).then((m) => m.map((x) => x.tenantId));
  }

  @Post('members')
  listPost(@Tenant() ctx: TenantContext, @Body() _body: unknown) {
    seenCtx = ctx;
    return this.memberships.listMembers(ctx).then((m) => m.map((x) => x.tenantId));
  }
}

describe('Tenant context + tenant-scoped repository (B2.1, INV-24)', () => {
  let app: NestFastifyApplication;
  let redis: IORedis;
  let sessions: SessionService;
  let model: Model<UserTenant>;
  const alice = new Types.ObjectId().toString(); // member of A
  const bob = new Types.ObjectId().toString(); // member of B
  const mallory = new Types.ObjectId().toString(); // no membership
  const users: string[] = [alice, bob, mallory];

  beforeAll(async () => {
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    const config = {
      getOrThrow: (ns: string) =>
        ns === 'session'
          ? { cookieSecure: true }
          : { sessionIdleTtl: 600, sessionAbsoluteTtl: 3600 },
    };
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(MONGO_URI, {
          serverSelectionTimeoutMS: 5000,
          retryAttempts: 5,
          retryDelay: 1000,
        }),
        MongooseModule.forFeature(MODELS),
      ],
      controllers: [MembersController],
      providers: [
        { provide: ConfigService, useValue: config },
        { provide: RedisService, useValue: new RedisService(redis) },
        SessionService,
        SessionCookie,
        UserTenantService,
        TenantGuard,
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(cookie);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    sessions = app.get(SessionService);
    model = app.get<Model<UserTenant>>(getModelToken('UserTenant'));
    await model.syncIndexes();

    const svc = app.get(UserTenantService);
    await svc.addMembership(alice, 'tenant-A', ['member']);
    await svc.addMembership(new Types.ObjectId().toString(), 'tenant-A');
    await svc.addMembership(bob, 'tenant-B');
    await svc.addMembership(new Types.ObjectId().toString(), 'tenant-B');
    await svc.addMembership(new Types.ObjectId().toString(), 'tenant-B');
  }, 30_000);

  afterAll(async () => {
    for (const u of users) await sessions.revokeAllForUser(u);
    await model.db.dropDatabase();
    await app.close(); // closes the Mongo connection; RedisService quits the client
  });

  const call = (method: 'GET' | 'POST', url: string, sessionId?: string, payload?: unknown) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url,
        headers: {
          ...(sessionId ? { cookie: `idp_session=${sessionId}` } : {}),
          'x-tenant-id': 'tenant-B',
        },
        payload: payload as Record<string, unknown> | undefined,
      });

  it('no session → 401; unknown session → 401', async () => {
    expect((await call('GET', '/members')).statusCode).toBe(401);
    expect((await call('GET', '/members', 'forged')).statusCode).toBe(401);
  });

  it('session without active membership → 403; membership removed → access lost immediately', async () => {
    const { id } = await sessions.create(mallory, 'tenant-A');
    expect((await call('GET', '/members', id)).statusCode).toBe(403);

    const { id: aliceId } = await sessions.create(alice, 'tenant-A');
    expect((await call('GET', '/members', aliceId)).statusCode).toBe(200);
    await model.updateOne({ userId: new Types.ObjectId(alice) }, { status: 'suspended' });
    expect((await call('GET', '/members', aliceId)).statusCode).toBe(403);
    await model.updateOne({ userId: new Types.ObjectId(alice) }, { status: 'active' });
  });

  it('tenantId in query/body/header is ignored; tenant comes from the session only', async () => {
    const { id } = await sessions.create(alice, 'tenant-A');
    const viaQuery = await call('GET', '/members?tenantId=tenant-B', id);
    const viaBody = await call('POST', '/members', id, { tenantId: 'tenant-B' });
    for (const res of [viaQuery, viaBody]) {
      expect(res.statusCode).toBeLessThan(300);
      expect(res.json()).toEqual(['tenant-A', 'tenant-A']);
    }
    expect(seenCtx).toMatchObject({ tenantId: 'tenant-A', userId: alice });
    expect(Object.isFrozen(seenCtx)).toBe(true);
  });

  describe('TenantScopedRepository', () => {
    // A TenantContext can only come from TenantGuard; tests forge one to exercise the repo directly.
    const ctxA = {
      tenantId: 'tenant-A',
      userId: alice,
      sessionRef: 'x',
    } as unknown as TenantContext;
    let repo: TenantScopedRepository<UserTenant>;
    beforeAll(() => {
      repo = new TenantScopedRepository(model);
    });

    it('context A never sees tenant B data, even when the filter names tenant B', async () => {
      expect(await repo.findOne(ctxA, { userId: new Types.ObjectId(bob) })).toBeNull();
      expect(await repo.find(ctxA, { tenantId: 'tenant-B' } as never)).toHaveLength(2);
      expect(
        (await repo.find(ctxA, { tenantId: 'tenant-B' } as never)).every(
          (m) => m.tenantId === 'tenant-A',
        ),
      ).toBe(true);
    });

    it('update/delete cannot reach tenant B or move a doc to another tenant', async () => {
      const bobId = new Types.ObjectId(bob);
      const upd = await repo.updateOne(ctxA, { userId: bobId }, { $set: { roles: ['pwned'] } });
      expect(upd.matchedCount).toBe(0);
      const del = await repo.deleteOne(ctxA, { userId: bobId, tenantId: 'tenant-B' } as never);
      expect(del.deletedCount).toBe(0);
      expect(await model.exists({ userId: bobId, tenantId: 'tenant-B' })).not.toBeNull();

      const aliceId = new Types.ObjectId(alice);
      await repo.updateOne(ctxA, { userId: aliceId }, {
        $set: { tenantId: 'tenant-B', roles: ['admin'] },
        tenantId: 'tenant-B',
      } as never);
      const after = await model.findOne({ userId: aliceId }).lean();
      expect(after).toMatchObject({ tenantId: 'tenant-A', roles: ['admin'] });
    });

    it('create takes tenantId from the context, ignoring the input', async () => {
      const uid = new Types.ObjectId();
      const created = await repo.create(ctxA, {
        userId: uid,
        tenantId: 'tenant-B',
        status: 'active',
        roles: [],
        createdAt: new Date(),
      } as never);
      expect(created.tenantId).toBe('tenant-A');
      expect(await model.exists({ userId: uid, tenantId: 'tenant-B' })).toBeNull();
      await model.deleteOne({ userId: uid });
    });

    it('rejects a missing context', async () => {
      expect(() => repo.find(undefined as unknown as TenantContext)).toThrow(/TenantContext/);
    });
  });
});
