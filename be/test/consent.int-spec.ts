import { ConfigService } from '@nestjs/config';
import mongoose, { Types, type Connection, type Model } from 'mongoose';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { ConsentService, type Consent } from '../src/modules/oauth/consent/consent.service';

const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-consent-${Date.now()}?directConnection=true`;

function config(policyVersion = '1', termsVersion = '1'): ConfigService {
  const base: Record<string, unknown> = { consent: { policyVersion, termsVersion } };
  return { getOrThrow: (ns: string) => base[ns] } as unknown as ConfigService;
}

describe('ConsentService on real Mongo (B4.2a, spec Â§9.4/Â§10, Q1 user Ã— client Ã— resource)', () => {
  let connection: Connection;
  let model: Model<Consent>;
  let service: ConsentService;

  const CLIENT = 'consent-client';
  const RES_A = 'https://api-a.example/';
  const RES_B = 'https://api-b.example/';
  const ALLOWED = ['openid', 'profile', 'email', 'offline_access'];

  beforeAll(async () => {
    connection = await mongoose.createConnection(MONGO_URI, { autoIndex: false }).asPromise();
    for (const { name, schema } of MODELS) connection.model(name, schema);
    await syncAllIndexes(connection);
    model = connection.model<Consent>('Consent');
    service = new ConsentService(model, config());
  }, 30_000);

  afterAll(async () => {
    await connection.dropDatabase();
    await connection.close();
  });

  const user = () => new Types.ObjectId().toHexString();
  const versions = () => service.currentVersions();

  it('normalizeResource maps undefined -> "" sentinel, keeps a real value', () => {
    expect(ConsentService.normalizeResource(undefined)).toBe('');
    expect(ConsentService.normalizeResource(RES_A)).toBe(RES_A);
  });

  it('isCovered: enough scope + right version => true; missing scope => false', async () => {
    const u = user();
    await service.grant(u, CLIENT, RES_A, ['openid', 'profile'], versions(), ALLOWED);
    const c = await service.find(u, CLIENT, RES_A);
    expect(service.isCovered(c, ['openid'], versions())).toBe(true);
    expect(service.isCovered(c, ['openid', 'profile'], versions())).toBe(true);
    expect(service.isCovered(c, ['openid', 'email'], versions())).toBe(false);
  });

  it('isCovered: version drift => false even when all scopes are present', async () => {
    const u = user();
    await service.grant(u, CLIENT, RES_A, ['openid'], versions(), ALLOWED);
    const c = await service.find(u, CLIENT, RES_A);
    expect(service.isCovered(c, ['openid'], { policyVersion: '2', termsVersion: '1' })).toBe(false);
    expect(service.isCovered(c, ['openid'], { policyVersion: '1', termsVersion: '2' })).toBe(false);
  });

  it('isCovered: null consent (none) => false (fail-closed, no auto-approve)', () => {
    expect(service.isCovered(null, ['openid'], versions())).toBe(false);
  });

  it('grant is idempotent/atomic: two concurrent grants of the same key => exactly one record', async () => {
    const u = user();
    await Promise.all([
      service.grant(u, CLIENT, RES_A, ['openid'], versions(), ALLOWED),
      service.grant(u, CLIENT, RES_A, ['profile'], versions(), ALLOWED),
    ]);
    const count = await model.countDocuments({ userId: new Types.ObjectId(u), clientId: CLIENT, resource: RES_A });
    expect(count).toBe(1);
  });

  it('two resources of the same user Ã— client are independent records', async () => {
    const u = user();
    await service.grant(u, CLIENT, RES_A, ['openid'], versions(), ALLOWED);
    await service.grant(u, CLIENT, RES_B, ['profile'], versions(), ALLOWED);
    const a = await service.find(u, CLIENT, RES_A);
    const b = await service.find(u, CLIENT, RES_B);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.grantedScopes).toEqual(['openid']);
    expect(b!.grantedScopes).toEqual(['profile']);

    // Revoke A by marking revokedAt; B is unaffected.
    await model.updateOne(
      { userId: new Types.ObjectId(u), clientId: CLIENT, resource: RES_A },
      { $set: { revokedAt: new Date() } },
    );
    expect(await service.find(u, CLIENT, RES_A)).toBeNull();
    expect(await service.find(u, CLIENT, RES_B)).not.toBeNull();
  });

  it('public client (no resource) grants/covers on the "" sentinel record', async () => {
    const u = user();
    await service.grant(u, CLIENT, undefined, ['openid'], versions(), ALLOWED);
    const stored = await model.findOne({ userId: new Types.ObjectId(u), clientId: CLIENT }).lean<Consent>();
    expect(stored!.resource).toBe('');
    const c = await service.find(u, CLIENT, undefined);
    expect(service.isCovered(c, ['openid'], versions())).toBe(true);
  });

  it('grant unions new scopes with existing and clears revokedAt (re-grant)', async () => {
    const u = user();
    await service.grant(u, CLIENT, RES_A, ['openid'], versions(), ALLOWED);
    await model.updateOne(
      { userId: new Types.ObjectId(u), clientId: CLIENT, resource: RES_A },
      { $set: { revokedAt: new Date() } },
    );
    await service.grant(u, CLIENT, RES_A, ['profile'], versions(), ALLOWED);
    const c = await service.find(u, CLIENT, RES_A);
    expect(c).not.toBeNull();
    expect(c!.revokedAt ?? null).toBeNull();
    expect(new Set(c!.grantedScopes)).toEqual(new Set(['openid', 'profile']));
  });

  it('grant bounds scopes by the clients current allowed scopes (no stale carry-forward)', async () => {
    const u = user();
    await service.grant(u, CLIENT, RES_A, ['openid', 'profile'], versions(), ALLOWED);
    // Client later loses "profile"; re-grant with only "openid" requested + narrowed allow-list.
    await service.grant(u, CLIENT, RES_A, ['openid'], versions(), ['openid', 'email']);
    const c = await service.find(u, CLIENT, RES_A);
    expect(c!.grantedScopes).toEqual(['openid']); // "profile" dropped, not allowed anymore
  });

  it('bumping the current version makes a previously-covering grant stop covering', async () => {
    const u = user();
    await service.grant(u, CLIENT, RES_A, ['openid'], versions(), ALLOWED);
    const bumped = new ConsentService(model, config('2', '1'));
    const c = await bumped.find(u, CLIENT, RES_A);
    expect(bumped.isCovered(c, ['openid'], bumped.currentVersions())).toBe(false);
  });

  // --- Tester (run 12) added coverage: concurrency + negative-actor invariants ---

  // Security invariant (never over-grant): even under heavy concurrency, grant must stay on the
  // unique key (exactly one record) and must NEVER record a scope outside the client's current
  // allow-list. Union-loss (last-writer-wins dropping a *requested & allowed* scope) is the known,
  // accepted, fail-closed DEBT-027 — it only forces a harmless re-consent, never an over-grant.
  it('grant under heavy concurrency: one record, never over-grants beyond allow-list (DEBT-027 is fail-closed)', async () => {
    const u = user();
    const ALLOW = ['openid', 'profile', 'email'];
    // 12 concurrent grants, each asking for a different single allowed scope + one NOT allowed.
    const asks = [
      ['openid', 'admin'],
      ['profile', 'root'],
      ['email', 'superuser'],
      ['openid', 'profile'],
      ['profile', 'email'],
      ['email', 'openid'],
      ['openid'],
      ['profile'],
      ['email'],
      ['openid', 'email'],
      ['profile', 'openid'],
      ['email', 'profile'],
    ];
    await Promise.all(asks.map((scopes) => service.grant(u, CLIENT, RES_A, scopes, versions(), ALLOW)));

    const count = await model.countDocuments({
      userId: new Types.ObjectId(u),
      clientId: CLIENT,
      resource: RES_A,
    });
    expect(count).toBe(1); // unique composite key holds under concurrency

    const c = await service.find(u, CLIENT, RES_A);
    expect(c).not.toBeNull();
    // INVARIANT (must hold): no scope outside the allow-list is ever persisted (no over-grant).
    const allowSet = new Set(ALLOW);
    for (const s of c!.grantedScopes) expect(allowSet.has(s)).toBe(true);
    // And every stored scope is a legitimate allowed scope; at least one scope survives.
    expect(c!.grantedScopes.length).toBeGreaterThanOrEqual(1);
  });

  // Negative actor / IDOR: `grant` keys strictly on the (userId, clientId, resource) passed by the
  // caller (always the authenticated session user at the wire). A grant for user A must never be
  // readable/attributable to user B — proves no cross-user bleed at the store boundary.
  it('grant for user A is isolated from user B on the same client+resource (no cross-user bleed)', async () => {
    const a = user();
    const b = user();
    await service.grant(a, CLIENT, RES_A, ['openid', 'profile'], versions(), ALLOWED);
    // B has granted nothing.
    expect(await service.find(b, CLIENT, RES_A)).toBeNull();
    expect(service.isCovered(await service.find(b, CLIENT, RES_A), ['openid'], versions())).toBe(false);
    // A's grant is intact and only visible to A.
    const ca = await service.find(a, CLIENT, RES_A);
    expect(ca).not.toBeNull();
    expect(new Set(ca!.grantedScopes)).toEqual(new Set(['openid', 'profile']));
  });

  // Re-grant after a version bump must update the stored versions (so a later isCovered under the
  // new current versions passes) — proves grant is the single place that advances policy/terms.
  it('re-grant under bumped versions updates stored versions in place (one record, now covered)', async () => {
    const u = user();
    await service.grant(u, CLIENT, RES_A, ['openid'], versions(), ALLOWED);
    const bumped = new ConsentService(model, config('2', '3'));
    // Not covered yet under the new versions.
    expect(bumped.isCovered(await bumped.find(u, CLIENT, RES_A), ['openid'], bumped.currentVersions())).toBe(false);
    // User re-consents under the new versions.
    await bumped.grant(u, CLIENT, RES_A, ['openid'], bumped.currentVersions(), ALLOWED);
    const count = await model.countDocuments({ userId: new Types.ObjectId(u), clientId: CLIENT, resource: RES_A });
    expect(count).toBe(1); // updated in place, not duplicated
    expect(bumped.isCovered(await bumped.find(u, CLIENT, RES_A), ['openid'], bumped.currentVersions())).toBe(true);
  });
});