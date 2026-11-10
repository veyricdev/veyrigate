import { randomBytes, randomUUID } from 'node:crypto';
import { Types, type Model } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { TokenSigner } from '../src/modules/keys/token-signer';
import { ResourceService } from '../src/modules/resources/resource.service';
import {
  bootFullApp,
  FLOW_ADMIN_AUD,
  FLOW_REDIRECT,
  seedFlowClient,
  type FullApp,
  type InjectResponse,
} from './full-app';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';
import { seedOAuthUser } from './oauth-fixtures';

/**
 * Run 82 backend-dev, on the REAL app (`AppModule` + `configureApp`) over HTTP:
 * - T1 DEBT-538: client and resource `scopes` follow RFC 6749 §3.3 `scope-token`
 *   (`%x21 / %x23-5B / %x5D-7E`); `expectedScopes` keeps the loose stored rule so a resource
 *   holding a legacy token can still be repaired.
 * - T2 DEBT-533: client config 400s carry a fixed message, never the offending value.
 * - T3 DEBT-537: `expectedScopes` matches `stored.scopes ?? []` exactly (the admin view).
 */
const CONFLICT_BODY =
  '{"error":"conflict","error_description":"The resource was changed since it was read."}';

const BAD_TOKENS: Array<[string, string]> = [
  ['ZWSP', 'zw​'],
  ['bidi RLO', 'a‮b'],
  ['soft hyphen', 'a­b'],
  ['double quote', 'a"b'],
  ['backslash', 'a\\b'],
  ['DEL', 'a\u007Fb'],
  ['non-ASCII letter', 'café'],
  ['space', 'a b'],
];
const GOOD_TOKENS = ["!#$%&'()*+,-./:;<=>?@[]^_`{|}~", 'admin.read', 'urn:x:y/z'];

describe('run 82 backend: scope token grammar, fixed client config messages, expectedScopes view', () => {
  let full: FullApp;
  let bff: { clientId: string; secret: string };
  let resourceModel: Model<Record<string, unknown>>;
  let clientModel: Model<Record<string, unknown>>;
  let auditModel: Model<Record<string, unknown>>;
  const ids = { superA: '', tenantA: '' };

  const boot = async (): Promise<void> => {
    full = await bootFullApp({ name: 'run82b' });
    resourceModel = full.conn.model<Record<string, unknown>>('Resource');
    clientModel = full.conn.model<Record<string, unknown>>('Client');
    auditModel = full.conn.model<Record<string, unknown>>('AuditLog');
    bff = await seedFlowClient(full);
    ids.superA = await adminUser('super_admin');
    ids.tenantA = await adminUser('tenant_admin');
  };
  let setup: Promise<void> | undefined;
  beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await settled(setup);
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);

  async function adminUser(role: string): Promise<string> {
    const userId = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
    await full.conn
      .model('UserTenant')
      .updateOne(
        { userId: new Types.ObjectId(userId), tenantId: DEFAULT_TENANT_ID },
        { $set: { roles: [role] } },
      );
    return userId;
  }

  /** Admin AT as `/token` mints it (aud=admin, sid, auth_time), signed by the app's own key. */
  const tok = (sub: string) =>
    full.app.get(TokenSigner).sign(
      {
        scope: 'openid admin.read admin.write',
        client_id: bff.clientId,
        sid: randomBytes(32).toString('hex'),
        auth_time: Math.floor(Date.now() / 1000),
      },
      { audience: FLOW_ADMIN_AUD, subject: sub, expiresInSec: 900, typ: 'at+jwt' },
    );

  const call = async (
    method: 'POST' | 'PATCH',
    url: string,
    payload: unknown,
    as: string = ids.superA,
  ) =>
    full.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${await tok(as)}`, 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    }) as Promise<InjectResponse>;

  const countAudits = (action: string, targetId?: string) =>
    auditModel.countDocuments({ action, ...(targetId ? { targetId } : {}) });

  const publicClient = (over: Record<string, unknown> = {}) => ({
    clientType: 'public',
    tokenEndpointAuthMethod: 'none',
    redirectUris: [FLOW_REDIRECT],
    allowedResources: ['api'],
    scopes: ['openid', 'api.read'],
    ...over,
  });
  const mkClient = async (): Promise<string> => {
    const res = await call('POST', '/admin/clients', publicClient(), ids.tenantA);
    expect(res.statusCode).toBe(201);
    return res.json().clientId as string;
  };
  const clientDoc = (clientId: string) => clientModel.findOne({ clientId }).lean();

  const mkResource = async (scopes: unknown = ['r82.read']): Promise<string> => {
    const resourceId = `r82b-${randomUUID().slice(0, 8)}`;
    await full.app.get(ResourceService).create({
      resourceId,
      identifier: `https://${resourceId}.example.com/`,
      scopes: [],
    });
    // Raw write (int DB only): legacy / impossible-through-the-API shapes.
    if (scopes === 'unset')
      await resourceModel.updateOne({ resourceId }, { $unset: { scopes: 1 } });
    else await resourceModel.updateOne({ resourceId }, { $set: { scopes } });
    return resourceId;
  };
  const storedScopes = async (resourceId: string) =>
    (await resourceModel.findOne({ resourceId }).lean())?.scopes;

  // ------------------------------------------------------------------ T1 DEBT-538

  describe('T1 DEBT-538: scope-token grammar (RFC 6749 §3.3)', () => {
    it.each(BAD_TOKENS)(
      'client POST scopes with %s => 400, nothing stored, no audit',
      async (_l, t) => {
        const audits0 = await countAudits('ADMIN_CLIENT_CREATED');
        const clients0 = await clientModel.countDocuments({});
        const res = await call(
          'POST',
          '/admin/clients',
          publicClient({ scopes: ['openid', t] }),
          ids.tenantA,
        );
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe('invalid_request');
        expect(await clientModel.countDocuments({})).toBe(clients0);
        expect(await countAudits('ADMIN_CLIENT_CREATED')).toBe(audits0);
      },
    );

    it.each(BAD_TOKENS)(
      'client PATCH scopes with %s => 400, DB unchanged, no audit',
      async (_l, t) => {
        const clientId = await mkClient();
        const before = await clientDoc(clientId);
        const res = await call('PATCH', `/admin/clients/${clientId}`, { scopes: [t] }, ids.tenantA);
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe('invalid_request');
        expect((await clientDoc(clientId))?.scopes).toEqual(before?.scopes);
        expect(await countAudits('ADMIN_CLIENT_UPDATED', clientId)).toBe(0);
      },
    );

    it.each(BAD_TOKENS)(
      'resource POST scopes with %s => 400, nothing stored, no audit',
      async (_l, t) => {
        const resourceId = `r82b-${randomUUID().slice(0, 8)}`;
        const audits0 = await countAudits('ADMIN_RESOURCE_CREATED');
        const res = await call('POST', '/admin/resources', {
          resourceId,
          identifier: `https://${resourceId}.example.com/`,
          scopes: [t],
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe('invalid_request');
        expect(await resourceModel.countDocuments({ resourceId })).toBe(0);
        expect(await countAudits('ADMIN_RESOURCE_CREATED')).toBe(audits0);
      },
    );

    it.each(BAD_TOKENS)(
      'resource PATCH scopes with %s => 400, DB unchanged, no audit',
      async (_l, t) => {
        const resourceId = await mkResource();
        const res = await call('PATCH', `/admin/resources/${resourceId}`, { scopes: [t] });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe('invalid_request');
        expect(await storedScopes(resourceId)).toEqual(['r82.read']);
        expect(await countAudits('ADMIN_RESOURCE_UPDATED', resourceId)).toBe(0);
      },
    );

    it('every grammar-valid token is accepted on client POST/PATCH and resource POST/PATCH', async () => {
      const created = await call(
        'POST',
        '/admin/clients',
        publicClient({ scopes: GOOD_TOKENS }),
        ids.tenantA,
      );
      expect(created.statusCode).toBe(201);
      const clientId = created.json().clientId as string;
      expect((await clientDoc(clientId))?.scopes).toEqual(GOOD_TOKENS);
      const patched = await call(
        'PATCH',
        `/admin/clients/${clientId}`,
        { scopes: [...GOOD_TOKENS].reverse() },
        ids.tenantA,
      );
      expect(patched.statusCode).toBe(200);
      expect((await clientDoc(clientId))?.scopes).toEqual([...GOOD_TOKENS].reverse());

      const resourceId = `r82b-${randomUUID().slice(0, 8)}`;
      const rc = await call('POST', '/admin/resources', {
        resourceId,
        identifier: `https://${resourceId}.example.com/`,
        scopes: GOOD_TOKENS,
      });
      expect(rc.statusCode).toBe(201);
      const rp = await call('PATCH', `/admin/resources/${resourceId}`, {
        scopes: [...GOOD_TOKENS].reverse(),
        expectedScopes: GOOD_TOKENS,
      });
      expect(rp.statusCode).toBe(200);
      expect(await storedScopes(resourceId)).toEqual([...GOOD_TOKENS].reverse());
    });

    it('a resource holding a legacy out-of-grammar token is repairable: clean scopes + expectedScopes = the legacy value => 200', async () => {
      const resourceId = await mkResource(['zw​']);
      const res = await call('PATCH', `/admin/resources/${resourceId}`, {
        scopes: ['ok'],
        expectedScopes: ['zw​'],
      });
      expect(res.statusCode).toBe(200);
      expect(await storedScopes(resourceId)).toEqual(['ok']);
      expect(await countAudits('ADMIN_RESOURCE_UPDATED', resourceId)).toBe(1);
    });
  });

  // ------------------------------------------------------------------ T2 DEBT-533

  describe('T2 DEBT-533: client config 400s carry a fixed message, never the value', () => {
    const WILDCARD = 'redirect_uri must not contain a wildcard';
    const ABSOLUTE = 'redirect_uri must be an absolute URI';
    const FRAGMENT = 'redirect_uri must not contain a fragment';
    const HOST = 'redirect_uri host contains an invalid character';
    const HTTPS = 'redirect_uri must use https (http://localhost only allowed outside production)';
    const URI_CASES: Array<[string, string, string]> = [
      ['wildcard + html', 'https://*.MARK.example/<svg/onload=alert(1)>', WILDCARD],
      ['not absolute + html', 'MARK<svg/onload=alert(1)>', ABSOLUTE],
      ['relative path', '/MARK/../../etc/passwd', ABSOLUTE],
      ['control characters', 'MARK\u0000\u0007\u001b[31m', ABSOLUTE],
      ['long', `MARK${'A'.repeat(1500)}`, ABSOLUTE],
      ['fragment html', 'https://a.example/cb#MARK<svg/onload=alert(1)>', FRAGMENT],
      ['host separator', 'https://a;MARK.example/cb', HOST],
      ['plain http', 'http://MARK.example/cb', HTTPS],
      ['javascript scheme', 'javascript:alert("MARK")', HTTPS],
    ];
    const ORIGIN = 'allowedCorsOrigins entry must be an exact origin';
    const ORIGIN_HTTPS =
      'allowedCorsOrigins entry must use https (http://localhost only outside production)';
    const UNKNOWN = 'allowedResources entry is not a known resource';
    type Field = [string, (v: string) => Record<string, unknown>];
    const URI_FIELDS: Field[] = [
      ['redirectUris', (v) => ({ redirectUris: [FLOW_REDIRECT, v] })],
      ['postLogoutRedirectUris', (v) => ({ postLogoutRedirectUris: [v] })],
      ['frontchannelLogoutUri', (v) => ({ frontchannelLogoutUri: v })],
    ];
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ...URI_FIELDS.flatMap(([f, body]) =>
        URI_CASES.map(
          ([l, v, m]) => [`${f} ${l}`, body(v), m] as [string, Record<string, unknown>, string],
        ),
      ),
      [
        'allowedCorsOrigins path + html',
        { allowedCorsOrigins: ['https://MARK.example/<svg>'] },
        ORIGIN,
      ],
      ['allowedCorsOrigins not a URL', { allowedCorsOrigins: ['MARK\u0000<b>'] }, ORIGIN],
      ['allowedCorsOrigins wildcard', { allowedCorsOrigins: ['https://*.MARK.example'] }, ORIGIN],
      ['allowedCorsOrigins long', { allowedCorsOrigins: [`MARK${'A'.repeat(1500)}`] }, ORIGIN],
      [
        'allowedCorsOrigins plain http',
        { allowedCorsOrigins: ['http://mark.example'] },
        ORIGIN_HTTPS,
      ],
      [
        'allowedResources unknown + html',
        { allowedResources: ['api', 'MARK<svg/onload=alert(1)>'] },
        UNKNOWN,
      ],
      ['allowedResources unknown control', { allowedResources: ['MARK\u0000\u001b[31m'] }, UNKNOWN],
      ['allowedResources unknown long', { allowedResources: [`MARK${'A'.repeat(1500)}`] }, UNKNOWN],
    ];
    const expectFixed = (res: InjectResponse, message: string) => {
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_request', error_description: message });
      for (const piece of ['MARK', 'svg', 'alert', 'passwd', 'example'])
        expect(res.body).not.toContain(piece);
    };

    it.each(cases)(
      'POST %s => 400 with the fixed message only, nothing stored, no audit',
      async (_l, over, message) => {
        const audits0 = await countAudits('ADMIN_CLIENT_CREATED');
        const clients0 = await clientModel.countDocuments({});
        expectFixed(await call('POST', '/admin/clients', publicClient(over), ids.tenantA), message);
        expect(await clientModel.countDocuments({})).toBe(clients0);
        expect(await countAudits('ADMIN_CLIENT_CREATED')).toBe(audits0);
      },
    );

    it.each(cases)(
      'PATCH %s => 400 with the fixed message only, DB unchanged, no audit',
      async (_l, over, message) => {
        const clientId = await mkClient();
        const before = await clientDoc(clientId);
        expectFixed(await call('PATCH', `/admin/clients/${clientId}`, over, ids.tenantA), message);
        expect(await clientDoc(clientId)).toEqual(before);
        expect(await countAudits('ADMIN_CLIENT_UPDATED', clientId)).toBe(0);
      },
    );
  });

  // ------------------------------------------------------------------ T3 DEBT-537

  describe('T3 DEBT-537: expectedScopes matches the admin view (stored.scopes ?? [])', () => {
    const patch = (resourceId: string, body: unknown) =>
      call('PATCH', `/admin/resources/${resourceId}`, body);
    const audits = (resourceId: string) => countAudits('ADMIN_RESOURCE_UPDATED', resourceId);

    it.each([
      ['null', null],
      ['absent field', 'unset'],
      ['[]', []],
    ])('stored %s + expectedScopes [] => 200, DB [x], 1 audit', async (_l, raw) => {
      const resourceId = await mkResource(raw);
      const res = await patch(resourceId, { scopes: ['x'], expectedScopes: [] });
      expect(res.statusCode).toBe(200);
      expect(await storedScopes(resourceId)).toEqual(['x']);
      expect(await audits(resourceId)).toBe(1);
    });

    it.each([
      ["['a'] vs []", ['a'], []],
      ['[null] vs []', [null], []],
      ["['a', null] vs []", ['a', null], []],
      ["['a','b'] vs ['b','a']", ['a', 'b'], ['b', 'a']],
      ["null vs ['a']", null, ['a']],
    ])('stored %s => 409 fixed body, DB unchanged, no audit', async (_l, raw, expected) => {
      const resourceId = await mkResource(raw);
      const res = await patch(resourceId, { scopes: ['x'], expectedScopes: expected });
      expect(res.statusCode).toBe(409);
      expect(res.body).toBe(CONFLICT_BODY);
      expect(await storedScopes(resourceId)).toEqual(raw);
      expect(await audits(resourceId)).toBe(0);
    });

    it("stored ['$resourceId'] + expectedScopes ['$resourceId'] => 200 (compared as a literal)", async () => {
      const same = await mkResource(['$resourceId']);
      const ok = await patch(same, { scopes: ['x'], expectedScopes: ['$resourceId'] });
      expect(ok.statusCode).toBe(200);
      expect(await storedScopes(same)).toEqual(['x']);
      expect(await audits(same)).toBe(1);
    });

    it("stored [R] (R = its own resourceId) + expectedScopes ['$resourceId'] => 409 (never a field path)", async () => {
      // Stored value = the resource's own resourceId: '$resourceId' as a path would match it.
      const other = await mkResource([]);
      await resourceModel.updateOne({ resourceId: other }, { $set: { scopes: [other] } });
      const res = await patch(other, { scopes: ['x'], expectedScopes: ['$resourceId'] });
      expect(res.statusCode).toBe(409);
      expect(res.body).toBe(CONFLICT_BODY);
      expect(await storedScopes(other)).toEqual([other]);
      expect(await audits(other)).toBe(0);
    });

    it('expectedScopes absent => last write wins (null stored included)', async () => {
      for (const raw of [null, ['r82.read']]) {
        const resourceId = await mkResource(raw);
        const res = await patch(resourceId, { scopes: ['y'] });
        expect(res.statusCode).toBe(200);
        expect(await storedScopes(resourceId)).toEqual(['y']);
        expect(await audits(resourceId)).toBe(1);
      }
    });

    it('unknown resource + expectedScopes [] => 404, never 409', async () => {
      const res = await patch(`r82b-missing-${randomUUID().slice(0, 8)}`, {
        scopes: ['x'],
        expectedScopes: [],
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
