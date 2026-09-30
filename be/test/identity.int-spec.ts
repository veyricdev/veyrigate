import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, type TestingModule } from '@nestjs/testing';
import { type Model, Types } from 'mongoose';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { FederatedIdentityService } from '../src/modules/identity/federated-identity.service';
import { DuplicateError } from '../src/modules/identity/identity.errors';
import { DEFAULT_TENANT_ID, TenantService } from '../src/modules/identity/tenant.service';
import { UserTenantService } from '../src/modules/identity/user-tenant.service';
import { UserService } from '../src/modules/identity/user.service';

const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-identity-${Date.now()}?directConnection=true`;

describe('Identity services on real Mongo (B2.2)', () => {
  let moduleRef: TestingModule;
  let users: UserService;
  let tenants: TenantService;
  let memberships: UserTenantService;
  let federated: FederatedIdentityService;
  let tenantModel: Model<unknown>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [MongooseModule.forRoot(MONGO_URI), MongooseModule.forFeature(MODELS)],
      providers: [TenantService, UserService, UserTenantService, FederatedIdentityService],
    }).compile();
    tenantModel = moduleRef.get(getModelToken('Tenant'));
    await syncAllIndexes(tenantModel.db);
    await moduleRef.init(); // runs OnApplicationBootstrap → default-tenant seed
    users = moduleRef.get(UserService);
    tenants = moduleRef.get(TenantService);
    memberships = moduleRef.get(UserTenantService);
    federated = moduleRef.get(FederatedIdentityService);
  }, 30_000);

  afterAll(async () => {
    await tenantModel.db.dropDatabase();
    await moduleRef.close();
  });

  it('seeds default-tenant at boot; running the seed again (also concurrently) does not duplicate', async () => {
    expect(await tenants.findById(DEFAULT_TENANT_ID)).toEqual({
      id: DEFAULT_TENANT_ID,
      name: 'Default',
    });
    await tenants.seedDefault();
    await Promise.all([tenants.seedDefault(), tenants.seedDefault(), tenants.seedDefault()]);
    expect(await tenantModel.countDocuments({ id: DEFAULT_TENANT_ID })).toBe(1);
  });

  it('creates a user with normalised email and hashed password; never returns passwordHash', async () => {
    const u = await users.create({ email: '  Alice@Example.COM ', password: 'correct horse' });
    expect(u.email).toBe('alice@example.com');
    expect(u.sub).toMatch(/^[0-9a-f]{24}$/);
    expect(u).not.toHaveProperty('passwordHash');
    const stored = await moduleRef
      .get<Model<{ passwordHash: string }>>(getModelToken('User'))
      .findById(u.sub)
      .select('+passwordHash')
      .lean();
    expect(stored?.passwordHash).toMatch(/^\$argon2id\$/);

    const byEmail = await users.findByEmail('ALICE@example.com ');
    expect(byEmail?.sub).toBe(u.sub);
    expect(byEmail).not.toHaveProperty('passwordHash');
    expect((await users.findById(u.sub))?.email).toBe('alice@example.com');
    expect(await users.findById('not-an-id')).toBeNull();
  });

  it('duplicate email (case-insensitive) → DuplicateError (domain error, not HTTP)', async () => {
    await users.create({ email: 'dup@example.com' });
    const err = await users.create({ email: 'DUP@example.com' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DuplicateError);
    expect((err as DuplicateError).entity).toBe('User');
    expect(err).not.toHaveProperty('getStatus');
  });

  it('changing email keeps sub, removes prior verification; changing to a taken email → DuplicateError', async () => {
    const u = await users.create({ email: 'bob@example.com' });
    await users.updateStatus(u.sub, { emailVerifiedAt: new Date() });
    const changed = await users.changeEmail(u.sub, 'Bobby@Example.com');
    expect(changed?.sub).toBe(u.sub);
    expect(changed?.email).toBe('bobby@example.com');
    expect(changed?.emailVerifiedAt).toBeUndefined();
    await expect(users.changeEmail(u.sub, 'alice@example.com')).rejects.toBeInstanceOf(
      DuplicateError,
    );
  });

  it('updates status fields only (emailVerifiedAt, failedLoginCount, lockedUntil)', async () => {
    const u = await users.create({ email: 'carol@example.com' });
    const at = new Date('2026-01-01T00:00:00Z');
    const lock = new Date('2026-01-02T00:00:00Z');
    const updated = await users.updateStatus(u.sub, {
      emailVerifiedAt: at,
      failedLoginCount: 3,
      lockedUntil: lock,
      email: 'hijack@example.com',
    } as never);
    expect(updated).toMatchObject({
      emailVerifiedAt: at,
      failedLoginCount: 3,
      lockedUntil: lock,
      email: 'carol@example.com',
    });
  });

  it('records failed logins atomically and locks at the fifth failure, then resets', async () => {
    const u = await users.create({ email: 'lock@example.com' });
    const now = new Date('2026-01-01T00:00:00Z');
    const failures = await Promise.all(
      Array.from({ length: 10 }, () => users.recordFailedLogin(u.sub, now)),
    );
    const locked = await users.findById(u.sub);
    expect(locked?.failedLoginCount).toBe(10);
    expect(locked?.lockedUntil).toEqual(new Date('2026-01-01T00:15:00Z'));
    expect(failures.filter((failure) => failure?.newlyLocked)).toHaveLength(1);
    const reset = await users.resetFailedLogins(u.sub);
    expect(reset?.failedLoginCount).toBe(0);
    expect(reset?.lockedUntil).toBeUndefined();
  });

  it('membership: add, check active, roles; duplicate membership → DuplicateError', async () => {
    const u = await users.create({ email: 'dave@example.com' });
    const m = await memberships.addMembership(u.sub, DEFAULT_TENANT_ID, ['member']);
    expect(m).toMatchObject({ tenantId: DEFAULT_TENANT_ID, status: 'active', roles: ['member'] });
    expect(await memberships.isActiveMember(u.sub, DEFAULT_TENANT_ID)).toBe(true);
    expect(await memberships.isActiveMember(u.sub, 'other-tenant')).toBe(false);
    await expect(memberships.addMembership(u.sub, DEFAULT_TENANT_ID)).rejects.toBeInstanceOf(
      DuplicateError,
    );
  });

  it('federated identity: link + find by provider+providerId; duplicate → DuplicateError; no email lookup/auto-link', async () => {
    const u = await users.create({ email: 'erin@example.com' });
    await federated.link({
      userId: u.sub,
      provider: 'google',
      providerId: 'g-123',
      email: 'erin@example.com',
      emailVerified: true,
    });
    const found = await federated.findByProvider('google', 'g-123');
    expect(found?.userId.toString()).toBe(u.sub);
    expect(await federated.findByProvider('github', 'g-123')).toBeNull();
    await expect(
      federated.link({
        userId: new Types.ObjectId().toString(),
        provider: 'google',
        providerId: 'g-123',
      }),
    ).rejects.toBeInstanceOf(DuplicateError);
    // No API resolves an identity by email (INV-22).
    expect(
      Object.getOwnPropertyNames(FederatedIdentityService.prototype).some((n) => /email/i.test(n)),
    ).toBe(false);
  });
});
