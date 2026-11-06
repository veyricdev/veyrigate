import { randomBytes, randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { SessionService } from '../src/modules/sessions/session.service';
import {
  authorizeCode,
  bootFullApp,
  FLOW_ADMIN_AUD,
  FLOW_REDIRECT,
  formPost,
  seedFlowClient,
  type FullApp,
  type InjectResponse,
} from './full-app';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';
import { seedConsent, seedOAuthUser } from './oauth-fixtures';

/**
 * Run 71 (DEBT-344, plan §12) on the REAL app over HTTP: `GET /admin/audit` returns the full `ip` /
 * `userAgent` to a super_admin only; any other admin gets the IPv4 /24 or IPv6 /48 prefix and NO
 * `userAgent` key, and the full values appear NOWHERE in the response body (metadata included).
 * The viewer's roles are read per request (live membership), so a demoted token is masked at once.
 * The app boots with AUDIT_RETENTION_DAYS=30: `autoIndex` (MongoModule) and `syncAllIndexes`
 * agree on 2592000 s (a model built with the default 180 would make the sync throw).
 */
const ADMIN_SCOPE = 'openid admin.read admin.write offline_access';

const SEED = [
  { ip: '203.0.113.77', masked: '203.0.113.0/24', ua: 'Mozilla/5.0 (r71-ua-v4)' },
  { ip: '2001:db8:abcd:12::1', masked: '2001:db8:abcd::/48', ua: 'r71-ua-v6' },
  { ip: '::ffff:198.51.100.23', masked: '198.51.100.0/24', ua: 'r71-ua-mapped' },
  { ip: '::ffff:c633:6417', masked: '198.51.100.0/24', ua: 'r71-ua-mapped-hex' },
  { ip: undefined, masked: undefined, ua: 'r71-ua-noip' },
  // Federation records `String(req.headers['user-agent'] ?? '')`: an empty UA.
  { ip: '192.0.2.200', masked: '192.0.2.0/24', ua: '' },
] as const;
const FULL_IPS = [
  '203.0.113.77',
  '2001:db8:abcd:12::1',
  '198.51.100.23',
  'c633:6417',
  '192.0.2.200',
];

type Item = { eventId: string; ip?: string; userAgent?: string };

describe('run 71: audit ip/userAgent per viewer over real HTTP (DEBT-344)', () => {
  let full: FullApp;
  let bff: { clientId: string; secret: string };
  const actorId = `r71-actor-${randomUUID()}`;
  const ids: Record<string, string> = {};
  const at: Record<string, string> = {};
  const eventIds: string[] = [];

  const boot = async (): Promise<void> => {
    full = await bootFullApp({ name: 'run71', env: { AUDIT_RETENTION_DAYS: '30' } });
    bff = await seedFlowClient(full);
    for (const [who, roles] of [
      ['tenant', ['tenant_admin']],
      ['super', ['super_admin']],
      ['both', ['tenant_admin', 'super_admin']],
      ['demoted', ['super_admin']],
    ] as const) {
      ids[who] = await adminUser([...roles]);
      at[who] = await login(ids[who]);
    }
    const audit = full.conn.model('AuditLog');
    for (const s of SEED) {
      const eventId = randomUUID();
      eventIds.push(eventId);
      await audit.create({
        eventId,
        timestamp: new Date(),
        actorType: 'user',
        actorId,
        tenantId: DEFAULT_TENANT_ID,
        action: 'AUTH_LOGIN_SUCCESS',
        result: 'success',
        ...(s.ip !== undefined ? { ip: s.ip } : {}),
        userAgent: s.ua,
        metadata: { note: 'r71' },
      });
    }
  };
  let setup: Promise<void> | undefined;
  beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await settled(setup);
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);

  async function adminUser(roles: string[]): Promise<string> {
    const userId = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
    await setRoles(userId, roles);
    return userId;
  }

  const setRoles = (userId: string, roles: string[]) =>
    full.conn
      .model('UserTenant')
      .updateOne(
        { userId: new Types.ObjectId(userId), tenantId: DEFAULT_TENANT_ID },
        { $set: { roles } },
      );

  async function login(userId: string): Promise<string> {
    await seedConsent(full.conn, {
      userId,
      clientId: bff.clientId,
      resource: FLOW_ADMIN_AUD,
      scopes: ADMIN_SCOPE.split(' '),
    });
    const verifier = randomBytes(32).toString('base64url');
    const sessionId = (await full.app.get(SessionService).create(userId, DEFAULT_TENANT_ID)).id;
    const code = await authorizeCode(full, {
      ...bff,
      sessionId,
      resource: FLOW_ADMIN_AUD,
      scope: ADMIN_SCOPE,
      verifier,
    });
    const res = await formPost(full, '/token', bff, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: FLOW_REDIRECT,
      code_verifier: verifier,
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ access_token: string }>().access_token;
  }

  async function list(token: string): Promise<{ body: string; byId: Map<string, Item> }> {
    const res = (await full.app.inject({
      method: 'GET',
      url: `/admin/audit?actorId=${actorId}&limit=50`,
      headers: { authorization: `Bearer ${token}` },
    })) as InjectResponse;
    expect(res.statusCode).toBe(200);
    const items = res.json<{ items: Item[] }>().items;
    expect(items).toHaveLength(SEED.length);
    return { body: res.body, byId: new Map(items.map((i) => [i.eventId, i])) };
  }

  function expectMasked({ body, byId }: { body: string; byId: Map<string, Item> }): void {
    SEED.forEach((s, n) => {
      const item = byId.get(eventIds[n])!;
      if (s.masked === undefined) expect('ip' in item).toBe(false);
      else expect(item.ip).toBe(s.masked);
      expect('userAgent' in item).toBe(false);
    });
    for (const ip of FULL_IPS) expect(body).not.toContain(ip);
    for (const s of SEED) if (s.ua) expect(body).not.toContain(s.ua);
    expect(body).not.toContain('userAgent');
  }

  function expectFull({ byId }: { byId: Map<string, Item> }): void {
    SEED.forEach((s, n) => {
      const item = byId.get(eventIds[n])!;
      expect(item.ip).toBe(s.ip);
      expect(item.userAgent).toBe(s.ua);
    });
  }

  it('the AuditLog TTL follows AUDIT_RETENTION_DAYS (30 days) on app boot + sync', async () => {
    const idx = (await full.conn.db!.collection('auditlogs').indexes()).find(
      (i) => i.name === 'timestamp_1',
    );
    expect(idx?.expireAfterSeconds).toBe(2592000);
  });

  it('tenant_admin: prefix only (IPv4 /24, IPv6 /48, mapped unmapped), no userAgent key, no full value in the body', async () => {
    expectMasked(await list(at.tenant));
  });

  it('super_admin and tenant_admin+super_admin: full stored values', async () => {
    expectFull(await list(at.super));
    expectFull(await list(at.both));
  });

  it('super_admin demoted to tenant_admin: the SAME token is masked on the next request', async () => {
    expectFull(await list(at.demoted));
    await setRoles(ids.demoted, ['tenant_admin']);
    expectMasked(await list(at.demoted));
  });
});
