import { jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { KeyProviderUnavailableError } from '../src/common/errors/dependency-unavailable';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { KEY_PROVIDER, type KeyProvider } from '../src/modules/keys/key-provider';
import { TokenSigner } from '../src/modules/keys/token-signer';
import {
  bootFullApp,
  FLOW_ADMIN_AUD,
  seedFlowClient,
  type FullApp,
  type InjectResponse,
} from './full-app';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';
import { seedOAuthUser } from './oauth-fixtures';

/**
 * Run 84 T2 (D84.2, DEBT-157) on the REAL app: a 200 `/jwks.json` (GET and HEAD) says
 * `Cache-Control: no-cache` (exactly: any `max-age` would let a CDN/RP keep a removed key after an
 * emergency rotate) and keeps `Vary: Origin`; a key-provider failure stays `no-store` and generic.
 */
const ORIGIN = 'https://spa.run84.example';

describe('run 84 T2: /jwks.json HTTP caching (real app)', () => {
  let full: FullApp;
  let superAdmin: string;
  let bff: { clientId: string; secret: string };

  const boot = async (): Promise<void> => {
    full = await bootFullApp({ name: 'run84-jwks' });
    bff = await seedFlowClient(full);
    await full.conn
      .model('Client')
      .updateOne({ clientId: bff.clientId }, { $set: { allowedCorsOrigins: [ORIGIN] } });
    superAdmin = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
    await full.conn
      .model('UserTenant')
      .updateOne(
        { userId: new Types.ObjectId(superAdmin), tenantId: DEFAULT_TENANT_ID },
        { $set: { roles: ['super_admin'] } },
      );
  };
  let setup: Promise<void> | undefined;
  beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await settled(setup);
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);
  afterEach(() => jest.restoreAllMocks());

  const jwks = (method: 'GET' | 'HEAD', origin?: string) =>
    full.app.inject({
      method,
      url: '/jwks.json',
      headers: origin ? { origin } : {},
    }) as Promise<InjectResponse>;

  const expectFresh = (res: InjectResponse) => {
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(String(res.headers.vary)).toMatch(/(^|,\s*)Origin(\s*,|$)/);
  };

  it.each([
    ['no Origin', undefined],
    ['registered Origin', ORIGIN],
    ['unknown Origin', 'https://evil.run84.example'],
  ])(
    'GET and HEAD with %s => 200, Cache-Control exactly no-cache, Vary: Origin',
    async (_n, origin) => {
      const get = await jwks('GET', origin);
      expectFresh(get);
      expect((get.json() as { keys: unknown[] }).keys.length).toBeGreaterThan(0);
      expect(get.headers['access-control-allow-origin']).toBe(
        origin === ORIGIN ? ORIGIN : undefined,
      );
      expectFresh(await jwks('HEAD', origin));
    },
  );

  it('key provider unavailable => 503 no-store, generic body (characterization)', async () => {
    const keys = full.app.get<KeyProvider>(KEY_PROVIDER);
    jest
      .spyOn(keys, 'getPublicKeys')
      .mockRejectedValue(new KeyProviderUnavailableError(new Error('vault said SECRET-DETAIL')));
    const res = await jwks('GET');
    expect(res.statusCode).toBe(503);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).not.toContain('SECRET-DETAIL');
    expect(res.body).not.toContain('key provider unavailable');
  });

  it('after an emergency rotate the very next GET carries only the new kid, still no-cache', async () => {
    const token = await full.app.get(TokenSigner).sign(
      {
        scope: 'openid admin.read admin.write',
        client_id: bff.clientId,
        sid: randomBytes(32).toString('hex'),
        auth_time: Math.floor(Date.now() / 1000),
      },
      { audience: FLOW_ADMIN_AUD, subject: superAdmin, expiresInSec: 900, typ: 'at+jwt' },
    );
    const rotate = await full.app.inject({
      method: 'POST',
      url: '/admin/keys/rotate',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ mode: 'emergency' }),
    });
    expect(rotate.statusCode).toBe(200);
    const { newKid } = rotate.json() as { newKid: string };
    const next = await jwks('GET');
    expectFresh(next);
    expect((next.json() as { keys: { kid: string }[] }).keys.map((k) => k.kid)).toEqual([newKid]);
  });
});
