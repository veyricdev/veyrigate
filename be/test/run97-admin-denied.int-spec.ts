import { randomBytes, randomUUID } from 'node:crypto';
import { Types, type Model } from 'mongoose';
import { sha256 } from '../src/common/crypto/crypto.util';
import { RedisService } from '../src/database/redis/redis.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { TokenSigner } from '../src/modules/keys/token-signer';
import { SessionService } from '../src/modules/sessions/session.service';
import {
  bootFullApp,
  FLOW_ADMIN_AUD,
  FLOW_API_AUD,
  seedFlowClient,
  type FullApp,
  type InjectResponse,
} from './full-app';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';
import { seedOAuthUser } from './oauth-fixtures';

/**
 * Run 97 T2 (DEBT-126, D97.7-D97.9) on the REAL app: every admin 401/403 is counted by wire error
 * (`sso_admin_auth_denied_total`); only a refusal AFTER the token signature verified writes an
 * `ADMIN_ACCESS_DENIED` audit, at most once per sub+reason per 15 min; `step_up_required` is only
 * counted. Wire responses unchanged.
 */
// Random per run, never printed (a 64-char hex value satisfies METRICS_TOKEN min(32)).
const METRICS_TOKEN = randomBytes(32).toString('hex');
const DENIED = 'ADMIN_ACCESS_DENIED';

describe('run 97 T2: admin denials are counted, verified ones audited once', () => {
  let full: FullApp;
  let bff: { clientId: string; secret: string };
  let auditModel: Model<Record<string, unknown>>;
  const subs: string[] = [];

  const boot = async (): Promise<void> => {
    full = await bootFullApp({ name: 'run97ad', env: { METRICS_TOKEN } });
    auditModel = full.conn.model<Record<string, unknown>>('AuditLog');
    bff = await seedFlowClient(full);
  };
  let setup: Promise<void> | undefined;
  beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS);
  // DEBT-708: the global 60/min audit cap (`rl:admin-deny-audit:account:<sha256(global)>`) is shared
  // Redis db0 state; a previous int suite may have burnt it. Delete exactly that one bucket key.
  const capKey = `rl:admin-deny-audit:account:${sha256('global')}`;
  beforeEach(async () => {
    await setup;
    await full.app.get(RedisService).client.del(capKey);
  }, INT_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await settled(setup);
    // Only the dedupe keys this spec created (one per sub+reason), never a pattern scan.
    const reasons = [
      'wrong_audience',
      'not_live',
      'not_admin_capable',
      'insufficient_scope',
      'forbidden',
    ];
    const keys = subs.flatMap((s) => reasons.map((r) => `adm_deny:{${sha256(s)}}:${r}`));
    if (full && keys.length) await full.app.get(RedisService).client.del(...keys);
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);

  async function user(role?: string): Promise<string> {
    const userId = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
    if (role) {
      await full.conn
        .model('UserTenant')
        .updateOne(
          { userId: new Types.ObjectId(userId), tenantId: DEFAULT_TENANT_ID },
          { $set: { roles: [role] } },
        );
    }
    subs.push(userId);
    return userId;
  }

  const sign = (
    sub: string,
    o: { scope?: string; sid?: string; authTime?: number; aud?: string } = {},
  ): Promise<string> =>
    full.app.get(TokenSigner).sign(
      {
        scope: o.scope ?? 'openid admin.read admin.write',
        client_id: bff.clientId,
        sid: o.sid ?? randomBytes(32).toString('hex'),
        auth_time: o.authTime ?? Math.floor(Date.now() / 1000),
      },
      { audience: o.aud ?? FLOW_ADMIN_AUD, subject: sub, expiresInSec: 900, typ: 'at+jwt' },
    );

  const call = (method: 'GET' | 'POST', url: string, bearer: string) =>
    full.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      ...(method === 'POST' ? { payload: '{}' } : {}),
    }) as Promise<InjectResponse>;

  const denied = async (reason: string): Promise<number> => {
    const res = await full.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const m = new RegExp(`^sso_admin_auth_denied_total\\{reason="${reason}"\\} (\\d+)$`, 'm').exec(
      res.body,
    );
    expect(m).not.toBeNull();
    return Number(m![1]);
  };

  const docs = (actorId?: string) =>
    auditModel
      .find({ action: DENIED, ...(actorId ? { actorId } : {}) })
      .lean()
      .exec();

  it('(a) garbage bearer x20 => 20x401 invalid_token, counter +20, no audit document', async () => {
    const before = await denied('invalid_token');
    const docs0 = (await docs()).length;
    for (let i = 0; i < 20; i++) {
      const res = await call('GET', '/admin/me', `garbage.${randomUUID()}.x`);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid_token' });
    }
    expect(await denied('invalid_token')).toBe(before + 20);
    expect((await docs()).length).toBe(docs0);
  });

  it('(b) admin token after logout x5 => 401 each, exactly 1 not_live document with the tenant (DEBT-707, visible on GET /admin/audit), no token in it', async () => {
    const sub = await user('tenant_admin');
    const sessions = full.app.get(SessionService);
    const { id, session } = await sessions.create(sub, DEFAULT_TENANT_ID);
    const at = await sign(sub, { sid: session.ref });
    expect((await call('GET', '/admin/me', at)).statusCode).toBe(200);
    await sessions.revoke(id); // logout: active termination (tombstone)
    const before = await denied('invalid_token');
    for (let i = 0; i < 5; i++) {
      const res = await call('GET', '/admin/me', at);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid_token' });
    }
    expect(await denied('invalid_token')).toBe(before + 5);
    const found = await docs(sub);
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual(
      expect.objectContaining({
        actorType: 'user',
        actorId: sub,
        clientId: bff.clientId,
        tenantId: DEFAULT_TENANT_ID,
        result: 'failure',
        metadata: { reason: 'not_live', method: 'GET', route: '/admin/me' },
      }),
    );
    // Another tenant admin of that tenant sees it on the console API.
    const viewer = await user('tenant_admin');
    const list = await call(
      'GET',
      `/admin/audit?actorId=${sub}&action=${DENIED}`,
      await sign(viewer),
    );
    expect(list.statusCode).toBe(200);
    const items = list.json().items as { eventId: string }[];
    expect(items.map((e) => e.eventId)).toEqual([found[0].eventId]);
    const text = JSON.stringify(found[0]);
    expect(text).not.toContain(at);
    expect(text).not.toContain(at.split('.')[2]);
    expect(text.toLowerCase()).not.toContain('authorization');
    expect(text).not.toMatch(/"(token|access_token|bearer)"/i);
  });

  it('(c) user token for another resource => 401 + 1 wrong_audience document', async () => {
    const sub = await user();
    const rp = await sign(sub, { aud: FLOW_API_AUD, scope: 'openid api.read' });
    for (let i = 0; i < 3; i++) {
      expect((await call('GET', '/admin/me', rp)).statusCode).toBe(401);
    }
    const found = await docs(sub);
    expect(found).toHaveLength(1);
    expect((found[0].metadata as Record<string, unknown>).reason).toBe('wrong_audience');
  });

  it('(d) admin without admin.write => 403 insufficient_scope + 1 document with the tenant', async () => {
    const sub = await user('tenant_admin');
    const at = await sign(sub, { scope: 'openid admin.read' });
    const before = await denied('insufficient_scope');
    const url = `/admin/users/${new Types.ObjectId().toHexString()}/lock`;
    for (let i = 0; i < 2; i++) {
      const res = await call('POST', url, at);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'insufficient_scope' });
    }
    expect(await denied('insufficient_scope')).toBe(before + 2);
    const found = await docs(sub);
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual(
      expect.objectContaining({
        tenantId: DEFAULT_TENANT_ID,
        metadata: { reason: 'insufficient_scope', method: 'POST', route: '/admin/users/:id/lock' },
      }),
    );
  });

  it('(e) stale step-up => 403 step_up_required, counter +1, no document', async () => {
    const sub = await user('tenant_admin');
    const at = await sign(sub, { authTime: Math.floor(Date.now() / 1000) - 3600 });
    const before = await denied('step_up_required');
    const res = await call('POST', `/admin/users/${new Types.ObjectId().toHexString()}/lock`, at);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'step_up_required', max_age: 0 });
    expect(await denied('step_up_required')).toBe(before + 1);
    expect(await docs(sub)).toHaveLength(0);
  });
});
