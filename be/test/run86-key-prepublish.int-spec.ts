import { jest } from '@jest/globals';
import { decodeProtectedHeader } from 'jose';
import { Types } from 'mongoose';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { KEY_PROVIDER } from '../src/modules/keys/key-provider';
import { LocalKeyProvider } from '../src/modules/keys/local-key-provider';
import { AuditService } from '../src/modules/security/audit/audit.service';
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
 * Run 86 T2 (DEBT-393, D85.7 + D86.8–D86.12) on the REAL app over HTTP: a normal rotation publishes
 * the new key as `pending` (in JWKS at once, signs from `activatesAt`), the old key keeps signing
 * until then and retires `ACCESS_TOKEN_TTL` later; a second normal rotation while a key is pending is
 * a fixed 409 `conflict` (audited `rotation_pending`, nothing changed); an emergency rotation leaves
 * one active key. The key provider is the real LocalKeyProvider with KEY_PREPUBLISH_SEC = 3600 and a
 * controllable clock (tokens still use the real clock).
 */
const PRE = 3600;
const TTL = 900; // full-app ACCESS_TOKEN_TTL
const SCOPE = 'openid admin.read admin.write offline_access';
const PENDING_409 = {
  error: 'conflict',
  error_description:
    'A newer signing key is already published and does not sign yet. Wait until it activates, or use an emergency rotation.',
};
const ITEM_KEYS = ['activatesAt', 'alg', 'createdAt', 'kid', 'retireAt', 'status'];
const ROTATE_KEYS = ['activatesAt', 'mode', 'newKid', 'oldKid'];
const KEY_MATERIAL = /"(n|e|d|p|q|dp|dq|qi)"|PRIVATE KEY|\.pem|keys\.json/;

type KeyItem = {
  kid: string;
  status: string;
  createdAt: string;
  activatesAt: string;
  retireAt: string | null;
};

describe('run 86 T2: signing key pre-publish (real app, Local provider)', () => {
  let full: FullApp;
  let keyDir: string;
  let offset = 0; // provider clock = real clock + offset
  let client: { clientId: string; secret: string };
  let userId = '';

  const boot = async (): Promise<void> => {
    keyDir = await mkdtemp(join(tmpdir(), 'vg-run86-keys-'));
    const provider = new LocalKeyProvider(keyDir, {
      prepublishSec: PRE,
      now: () => Date.now() + offset,
    });
    await provider.init();
    full = await bootFullApp({
      name: 'run86-prepublish',
      env: { KEY_PREPUBLISH_SEC: String(PRE) },
      override: (b) => b.overrideProvider(KEY_PROVIDER).useValue(provider),
    });
    client = await seedFlowClient(full);
    userId = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
    await full.conn
      .model('UserTenant')
      .updateOne(
        { userId: new Types.ObjectId(userId), tenantId: DEFAULT_TENANT_ID },
        { $set: { roles: ['super_admin'] } },
      );
    await seedConsent(full.conn, {
      userId,
      clientId: client.clientId,
      resource: FLOW_ADMIN_AUD,
      scopes: SCOPE.split(' '),
    });
  };
  let setup: Promise<void> | undefined;
  beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await settled(setup);
    await full?.close();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  }, INT_SETUP_TIMEOUT_MS);
  afterEach(() => jest.restoreAllMocks());

  /** A fresh super_admin AT (fresh session => step-up satisfied). */
  const adminToken = async (): Promise<string> => {
    const { id } = await full.app.get(SessionService).create(userId, DEFAULT_TENANT_ID);
    const verifier = randomBytes(32).toString('base64url');
    const code = await authorizeCode(full, {
      ...client,
      sessionId: id,
      resource: FLOW_ADMIN_AUD,
      scope: SCOPE,
      verifier,
    });
    const res = await formPost(full, '/token', client, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: FLOW_REDIRECT,
      code_verifier: verifier,
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ access_token: string }>().access_token;
  };
  const listKeys = async (at: string) => {
    const res = (await full.app.inject({
      method: 'GET',
      url: '/admin/keys',
      headers: { authorization: `Bearer ${at}` },
    })) as InjectResponse;
    return res;
  };
  const rotate = (at: string, mode: 'normal' | 'emergency') =>
    full.app.inject({
      method: 'POST',
      url: '/admin/keys/rotate',
      headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ mode }),
    }) as Promise<InjectResponse>;
  const jwksKids = async () =>
    (
      (await full.app.inject({ method: 'GET', url: '/jwks.json' })).json() as {
        keys: { kid: string }[];
      }
    ).keys.map((k) => k.kid);
  const items = async (at: string) => (await listKeys(at)).json<{ items: KeyItem[] }>().items;
  const audits = () =>
    full.conn
      .model('AuditLog')
      .find({ action: 'SIGNING_KEY_ROTATED', reason: 'rotation_pending' })
      .lean<Array<{ result: string; metadata?: Record<string, unknown> }>>();

  it('AC2–AC4/AC11: pending key published, old key signs, 409 while pending, then the new key signs and the old one retires', async () => {
    const at = await adminToken();
    const [old] = await items(at);
    expect(old).toMatchObject({ status: 'active', retireAt: null });
    expect(decodeProtectedHeader(at).kid).toBe(old.kid);

    const before = Date.now() + offset;
    const res = await rotate(at, 'normal');
    expect(res.statusCode).toBe(200);
    const r = res.json<{ newKid: string; oldKid: string; mode: string; activatesAt: string }>();
    expect(Object.keys(r).sort()).toEqual(ROTATE_KEYS);
    expect(r).toMatchObject({ oldKid: old.kid, mode: 'normal' });
    const act = Date.parse(r.activatesAt);
    expect(act - before).toBeGreaterThanOrEqual(PRE * 1000);
    expect(act - before).toBeLessThan(PRE * 1000 + 10_000);
    expect(res.body).not.toMatch(KEY_MATERIAL);

    // JWKS has both; the admin list shows active + pending; a new token is still signed by the old key.
    expect(await jwksKids()).toEqual([old.kid, r.newKid]);
    const list = await listKeys(at);
    expect(list.body).not.toMatch(KEY_MATERIAL);
    const meta = list.json<{ items: KeyItem[] }>().items;
    for (const item of meta) expect(Object.keys(item).sort()).toEqual(ITEM_KEYS);
    expect(meta.map((k) => [k.kid, k.status, k.retireAt])).toEqual([
      [old.kid, 'active', null],
      [r.newKid, 'pending', null],
    ]);
    expect(meta[1].activatesAt).toBe(r.activatesAt);
    const at2 = await adminToken();
    expect(decodeProtectedHeader(at2).kid).toBe(old.kid);

    // AC4: a second normal rotation => fixed 409, nothing changed, audited `rotation_pending`.
    const state = await readFile(join(keyDir, 'keys.json'), 'utf8');
    const pems = (await readdir(keyDir)).sort();
    const refused = await rotate(at2, 'normal');
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual(PENDING_409);
    expect(await readFile(join(keyDir, 'keys.json'), 'utf8')).toBe(state);
    expect((await readdir(keyDir)).sort()).toEqual(pems);
    const logged = await audits();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      result: 'failure',
      metadata: { mode: 'normal', pendingKid: r.newKid },
    });
    // An audit fault never turns the refusal into a 5xx.
    jest.spyOn(full.app.get(AuditService), 'record').mockRejectedValueOnce(new Error('down'));
    expect((await rotate(at2, 'normal')).statusCode).toBe(409);

    // AC3: at activatesAt the new key signs; the old one is retiring until activatesAt + TTL.
    offset = act - Date.now();
    const at3 = await adminToken();
    expect(decodeProtectedHeader(at3).kid).toBe(r.newKid);
    expect((await items(at3)).map((k) => [k.kid, k.status, k.retireAt])).toEqual([
      [old.kid, 'retiring', new Date(act + TTL * 1000).toISOString()],
      [r.newKid, 'active', null],
    ]);
    // The old key's tokens still verify while it is retiring...
    expect((await listKeys(at2)).statusCode).toBe(200);
    // ...and are refused once it left JWKS.
    offset = act + TTL * 1000 - Date.now();
    expect(await jwksKids()).toEqual([r.newKid]);
    expect((await listKeys(at2)).statusCode).toBe(401);
  });

  it('AC6: emergency while a key is pending => JWKS and the admin list hold one active key, old PEMs gone', async () => {
    const at = await adminToken();
    const r = await rotate(at, 'normal');
    expect(r.statusCode).toBe(200);
    expect((await items(at)).map((k) => k.status)).toEqual(['active', 'pending']);
    const e = await rotate(at, 'emergency');
    expect(e.statusCode).toBe(200);
    const { newKid, activatesAt } = e.json<{ newKid: string; activatesAt: string }>();
    expect(await jwksKids()).toEqual([newKid]);
    const fresh = await adminToken();
    const meta = await items(fresh);
    expect(meta).toEqual([
      expect.objectContaining({ kid: newKid, status: 'active', retireAt: null, activatesAt }),
    ]);
    expect(meta[0].activatesAt).toBe(meta[0].createdAt);
    expect((await readdir(keyDir)).filter((f) => f.endsWith('.pem'))).toEqual([`${newKid}.pem`]);
    expect((await listKeys(at)).statusCode).toBe(401);
  });

  it('AC11: the OpenAPI document has the 3-value status enum, activatesAt and the 409', async () => {
    const doc = (await full.app.inject({ method: 'GET', url: '/openapi/admin.json' })).json<{
      paths: Record<
        string,
        Record<string, { responses: Record<string, { description?: string }> }>
      >;
      components: { schemas: Record<string, { properties: Record<string, { enum?: string[] }> }> };
    }>();
    const key = doc.components.schemas.AdminKeyViewDto.properties;
    expect(key.status.enum).toEqual(['pending', 'active', 'retiring']);
    expect(key.activatesAt).toBeDefined();
    expect(doc.components.schemas.RotateKeyResultViewDto.properties.activatesAt).toBeDefined();
    expect(doc.paths['/admin/keys/rotate'].post.responses['409'].description).toContain(
      'rotation_pending',
    );
  });
});
