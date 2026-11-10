import { randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { Types, type Model } from 'mongoose';
import { ClientCredentialService } from '../src/modules/clients/client-credential.service';
import { ClientService } from '../src/modules/clients/client.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { TokenSigner } from '../src/modules/keys/token-signer';
import { ResourceService } from '../src/modules/resources/resource.service';
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
 * Run 82 tester, adversarial, on the REAL app (`AppModule` + `configureApp`) over HTTP:
 * - T1 DEBT-538: every boundary byte of RFC 6749 §3.3 `scope-token` on all 4 write paths, trailing
 *   `\n`, surrogate halves, combining marks, length limits, one bad item among good ones, a legacy
 *   stored token still served by `/authorize` (its admin edit => 400 fixed message), the repair path.
 * - T2 DEBT-533: hostile values (HTML, CRLF, 2 KB, secret look-alike) in every client config branch:
 *   never echoed in the body nor in pino; status/error code unchanged.
 * - T3 DEBT-537: `$`/dotted `expectedScopes`, stored null/absent/[]/[null]/['a',null], N parallel
 *   PATCHes against a `null`-stored resource => exactly 1 success; 409 body identical to run 81.
 */
const CONFLICT_BODY =
  '{"error":"conflict","error_description":"The resource was changed since it was read."}';

const hex = (c: number) => `0x${c.toString(16).toUpperCase().padStart(2, '0')}`;
/** Boundary bytes around each edge of `%x21 / %x23-5B / %x5D-7E`, plus the first non-ASCII ones. */
const BOUNDARY: Array<[string, string, boolean]> = [
  ...[0x20, 0x21, 0x22, 0x23, 0x5b, 0x5c, 0x5d, 0x7e, 0x7f, 0x80, 0x9f, 0xa0, 0xff, 0x100].map(
    (c): [string, string, boolean] => [
      hex(c),
      `a${String.fromCharCode(c)}b`,
      c === 0x21 || c === 0x23 || c === 0x5b || c === 0x5d || c === 0x7e,
    ],
  ),
  ['lone char 0x21', '!', true],
  ['lone char 0x7E', '~', true],
];
const BAD_SHAPES: Array<[string, string]> = [
  ['trailing \\n', 'abc\n'],
  ['leading \\n', '\nabc'],
  ['trailing \\r\\n', 'abc\r\n'],
  ['trailing \\r', 'abc\r'],
  ['tab', 'a\tb'],
  ['NUL', 'a\u0000b'],
  ['U+2028 line separator', 'abc '],
  ['lone high surrogate', 'a\uD800b'],
  ['lone low surrogate', 'a\uDC00b'],
  ['surrogate pair (emoji)', 'a😀b'],
  ['combining acute', 'é'],
  ['combining mark alone', '́'],
  ['fullwidth A', 'Ａ'],
  ['BOM', '﻿abc'],
  ['NBSP', 'a b'],
];
const LEGACY = 'zw​';

describe('run 82 tester: scope grammar boundaries, no echo of client config values, expectedScopes view', () => {
  let full: FullApp;
  let bff: { clientId: string; secret: string };
  let resourceModel: Model<Record<string, unknown>>;
  let clientModel: Model<Record<string, unknown>>;
  let auditModel: Model<Record<string, unknown>>;
  const ids = { superA: '', tenantA: '' };
  const pino: string[] = [];

  const boot = async (): Promise<void> => {
    full = await bootFullApp({
      name: 'run82t',
      logStream: new Writable({
        write(chunk, _e, cb) {
          pino.push(...String(chunk).split('\n').filter(Boolean));
          cb();
        },
      }),
    });
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
    const resourceId = `r82t-${randomUUID().slice(0, 8)}`;
    await full.app.get(ResourceService).create({
      resourceId,
      identifier: `https://${resourceId}.example.com/`,
      scopes: [],
    });
    if (scopes === 'unset')
      await resourceModel.updateOne({ resourceId }, { $unset: { scopes: 1 } });
    else await resourceModel.updateOne({ resourceId }, { $set: { scopes } });
    return resourceId;
  };
  const storedScopes = async (resourceId: string) =>
    (await resourceModel.findOne({ resourceId }).lean())?.scopes;

  /**
   * One scope array on all 4 write paths. Returns the 4 statuses; on a reject also checks nothing
   * was stored / changed and no success audit.
   */
  async function onAllPaths(scopes: string[]): Promise<number[]> {
    // client POST
    const clients0 = await clientModel.countDocuments({});
    const cAud0 = await countAudits('ADMIN_CLIENT_CREATED');
    const cPost = await call('POST', '/admin/clients', publicClient({ scopes }), ids.tenantA);
    if (cPost.statusCode >= 400) {
      expect(await clientModel.countDocuments({})).toBe(clients0);
      expect(await countAudits('ADMIN_CLIENT_CREATED')).toBe(cAud0);
    }
    // client PATCH
    const clientId = await mkClient();
    const before = await clientDoc(clientId);
    const cPatch = await call('PATCH', `/admin/clients/${clientId}`, { scopes }, ids.tenantA);
    if (cPatch.statusCode >= 400) {
      expect(await clientDoc(clientId)).toEqual(before);
      expect(await countAudits('ADMIN_CLIENT_UPDATED', clientId)).toBe(0);
    }
    // resource POST
    const rid = `r82t-${randomUUID().slice(0, 8)}`;
    const rPost = await call('POST', '/admin/resources', {
      resourceId: rid,
      identifier: `https://${rid}.example.com/`,
      scopes,
    });
    if (rPost.statusCode >= 400) {
      expect(await resourceModel.countDocuments({ resourceId: rid })).toBe(0);
      expect(await countAudits('ADMIN_RESOURCE_CREATED', rid)).toBe(0);
    }
    // resource PATCH
    const resourceId = await mkResource();
    const rPatch = await call('PATCH', `/admin/resources/${resourceId}`, {
      scopes,
      expectedScopes: ['r82.read'],
    });
    if (rPatch.statusCode >= 400) {
      expect(await storedScopes(resourceId)).toEqual(['r82.read']);
      expect(await countAudits('ADMIN_RESOURCE_UPDATED', resourceId)).toBe(0);
    } else {
      expect(await storedScopes(resourceId)).toEqual(scopes);
    }
    for (const r of [cPost, cPatch, rPost, rPatch]) {
      if (r.statusCode === 400) {
        expect(r.json().error).toBe('invalid_request');
        // ValidationPipe message: never the offending token.
        for (const s of scopes.filter(
          (x) => typeof x === 'string' && x !== '' && !/^[a-z.]+$/.test(x),
        ))
          expect(r.body).not.toContain(JSON.stringify(s).slice(1, -1));
      }
    }
    return [cPost.statusCode, cPatch.statusCode, rPost.statusCode, rPatch.statusCode];
  }

  // ------------------------------------------------------------------ T1 DEBT-538

  describe('T1 DEBT-538: boundary bytes and odd shapes on client POST/PATCH + resource POST/PATCH', () => {
    it.each(BOUNDARY)('byte %s on all 4 paths', async (_l, token, ok) => {
      const statuses = await onAllPaths([token]);
      expect(statuses).toEqual(ok ? [201, 200, 201, 200] : [400, 400, 400, 400]);
    });

    it.each(BAD_SHAPES)('%s => 400 on all 4 paths', async (_l, token) => {
      expect(await onAllPaths([token])).toEqual([400, 400, 400, 400]);
    });

    it('one bad item among good ones (first, middle, last) => 400 on all 4 paths', async () => {
      for (const scopes of [
        [LEGACY, 'openid', 'api.read'],
        ['openid', 'a"b', 'api.read'],
        ['openid', 'api.read', 'abc\n'],
      ])
        expect(await onAllPaths(scopes)).toEqual([400, 400, 400, 400]);
    });

    it('resource token at the 256 limit => 2xx; 257 => 400 (POST and PATCH)', async () => {
      const at = '~'.repeat(255) + '!';
      expect(at).toHaveLength(256);
      const rid = `r82t-${randomUUID().slice(0, 8)}`;
      const post = await call('POST', '/admin/resources', {
        resourceId: rid,
        identifier: `https://${rid}.example.com/`,
        scopes: [at],
      });
      expect(post.statusCode).toBe(201);
      expect(await storedScopes(rid)).toEqual([at]);
      const over = `${at}x`;
      const r2 = `r82t-${randomUUID().slice(0, 8)}`;
      const post2 = await call('POST', '/admin/resources', {
        resourceId: r2,
        identifier: `https://${r2}.example.com/`,
        scopes: [over],
      });
      expect(post2.statusCode).toBe(400);
      expect(post2.body).not.toContain('~~~~~~~~');
      const p1 = await call('PATCH', `/admin/resources/${rid}`, { scopes: [over] });
      expect(p1.statusCode).toBe(400);
      expect(await storedScopes(rid)).toEqual([at]);
      const p2 = await call('PATCH', `/admin/resources/${rid}`, {
        scopes: ['x'],
        expectedScopes: [at],
      });
      expect(p2.statusCode).toBe(200);
    });

    it('client token at the 2048 limit => 201; 2049 => 400', async () => {
      const at = 'a'.repeat(2048);
      const ok = await call('POST', '/admin/clients', publicClient({ scopes: [at] }), ids.tenantA);
      expect(ok.statusCode).toBe(201);
      const bad = await call(
        'POST',
        '/admin/clients',
        publicClient({ scopes: [`${at}a`] }),
        ids.tenantA,
      );
      expect(bad.statusCode).toBe(400);
    });

    it('non-string / empty items stay 400 (no regression from the new regex)', async () => {
      for (const scopes of [[''], [1], [null], [{ $gt: '' }], [['a']]] as unknown as string[][])
        expect(await onAllPaths(scopes)).toEqual([400, 400, 400, 400]);
    });

    it('legacy stored token: /authorize + /token still serve it; its admin edit => 400 fixed message, DB unchanged', async () => {
      const resourceId = `r82t-leg-${randomUUID().slice(0, 8)}`;
      const identifier = `https://${resourceId}.example.com/`;
      await full.app.get(ResourceService).create({ resourceId, identifier, scopes: [] });
      await resourceModel.updateOne({ resourceId }, { $set: { scopes: [LEGACY] } });
      const clientId = `r82t-leg-${randomUUID()}`;
      await full.app.get(ClientService).create({
        clientId,
        clientType: 'confidential',
        tokenEndpointAuthMethod: 'client_secret_basic',
        redirectUris: [FLOW_REDIRECT],
        allowedResources: [resourceId],
        scopes: ['openid'],
        grantTypes: ['authorization_code'],
        tenantId: DEFAULT_TENANT_ID,
      });
      await clientModel.updateOne({ clientId }, { $set: { scopes: ['openid', LEGACY] } });
      const { secret } = await full.app.get(ClientCredentialService).createSecret(clientId);
      const userId = await seedOAuthUser(full.conn, { tenantId: DEFAULT_TENANT_ID });
      await seedConsent(full.conn, {
        userId,
        clientId,
        resource: identifier,
        scopes: ['openid', LEGACY],
      });
      const sessionId = (await full.app.get(SessionService).create(userId, DEFAULT_TENANT_ID)).id;
      const verifier = randomBytes(32).toString('base64url');
      const code = await authorizeCode(full, {
        clientId,
        sessionId,
        resource: identifier,
        scope: `openid ${LEGACY}`,
        verifier,
      });
      const t = await formPost(
        full,
        '/token',
        { clientId, secret },
        {
          grant_type: 'authorization_code',
          code,
          redirect_uri: FLOW_REDIRECT,
          code_verifier: verifier,
        },
      );
      expect(t.statusCode).toBe(200);
      expect(String(t.json().scope).split(' ')).toContain(LEGACY);

      const before = await clientDoc(clientId);
      const res = await call('PATCH', `/admin/clients/${clientId}`, {
        scopes: ['openid', LEGACY],
      });
      expect(res.statusCode).toBe(400);
      const body = res.json<{ error: string; error_description: unknown }>();
      expect(body.error).toBe('invalid_request');
      expect(res.body).not.toContain('\\u200b');
      expect(res.body).not.toContain('​');
      expect(res.body).not.toContain('zw');
      // Fixed: the same text whatever the offending token is.
      const other = await call('PATCH', `/admin/clients/${clientId}`, { scopes: ['a"b'] });
      expect(other.statusCode).toBe(400);
      expect(other.json().error_description).toEqual(body.error_description);
      expect(await clientDoc(clientId)).toEqual(before);
      expect(await countAudits('ADMIN_CLIENT_UPDATED', clientId)).toBe(0);

      // Same for the resource edit sending the legacy array back.
      const r = await call('PATCH', `/admin/resources/${resourceId}`, {
        scopes: [LEGACY],
        expectedScopes: [LEGACY],
      });
      expect(r.statusCode).toBe(400);
      expect(r.body).not.toContain('zw');
      expect(await storedScopes(resourceId)).toEqual([LEGACY]);
    });

    it.each([
      ['ZWSP', [LEGACY]],
      ['bidi + good', ['ok', 'a‮b']],
      ['trailing \\n is NOT loose-valid', null],
      ['dollar + legacy', ['$x', 'café']],
    ] as Array<[string, string[] | null]>)(
      'repair %s: expectedScopes = legacy value, scopes valid => 200, 1 audit',
      async (_l, legacy) => {
        if (legacy === null) {
          // `\S` rejects `\n`, so a raw-stored `abc\n` cannot be named in expectedScopes => 400.
          const rid = await mkResource(['abc\n']);
          const res = await call('PATCH', `/admin/resources/${rid}`, {
            scopes: ['ok'],
            expectedScopes: ['abc\n'],
          });
          expect(res.statusCode).toBe(400);
          expect(await storedScopes(rid)).toEqual(['abc\n']);
          // ...but last-write-wins (no expectedScopes) still repairs it.
          const lww = await call('PATCH', `/admin/resources/${rid}`, { scopes: ['ok'] });
          expect(lww.statusCode).toBe(200);
          expect(await storedScopes(rid)).toEqual(['ok']);
          return;
        }
        const rid = await mkResource(legacy);
        const res = await call('PATCH', `/admin/resources/${rid}`, {
          scopes: ['ok.clean'],
          expectedScopes: legacy,
        });
        expect(res.statusCode).toBe(200);
        expect(await storedScopes(rid)).toEqual(['ok.clean']);
        expect(await countAudits('ADMIN_RESOURCE_UPDATED', rid)).toBe(1);
      },
    );
  });

  // ------------------------------------------------------------------ T2 DEBT-533

  describe('T2 DEBT-533: hostile client config values never echo (body, pino)', () => {
    const WILDCARD = 'redirect_uri must not contain a wildcard';
    const ABSOLUTE = 'redirect_uri must be an absolute URI';
    const FRAGMENT = 'redirect_uri must not contain a fragment';
    const HOST = 'redirect_uri host contains an invalid character';
    const HTTPS = 'redirect_uri must use https (http://localhost only allowed outside production)';
    const ORIGIN = 'allowedCorsOrigins entry must be an exact origin';
    const ORIGIN_HTTPS =
      'allowedCorsOrigins entry must use https (http://localhost only outside production)';
    const UNKNOWN = 'allowedResources entry is not a known resource';
    const SECRET = 'sk_live_Zq9MARKsecret';
    const JWTISH = 'eyJhbGciOiJIUzI1NiJ9.eyJNQVJLIjoxfQ.MARKsig';
    const KB2 = `MARK${'Q'.repeat(2000)}`;
    const URI_CASES: Array<[string, string, string]> = [
      ['wildcard + secret userinfo', `https://u:${SECRET}@*.mark.example/cb`, WILDCARD],
      ['wildcard + CRLF', 'https://*.mark.example/cb\r\nSet-Cookie: MARK=1', WILDCARD],
      ['jwt look-alike', JWTISH, ABSOLUTE],
      ['2 KB', KB2, ABSOLUTE],
      ['html', '<img src=x onerror=alert("MARK")>', ABSOLUTE],
      // WHATWG URL strips CR/LF => parses as scheme `marklocation:` => https branch.
      ['CRLF header', 'MARK\r\nLocation: https://evil.example', HTTPS],
      ['fragment + secret', `https://a.example/cb#access_token=${SECRET}`, FRAGMENT],
      ['host comma + html (< forbidden => unparsable)', 'https://a,MARK<b>.example/cb', ABSOLUTE],
      ['host comma', 'https://a,mark.example/cb', HOST],
      ['http + secret query', `http://mark.example/cb?client_secret=${SECRET}`, HTTPS],
      ['data: html', 'data:text/html,<script>MARK</script>', HTTPS],
    ];
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
      ['cors secret userinfo', { allowedCorsOrigins: [`https://u:${SECRET}@a.example`] }, ORIGIN],
      ['cors CRLF', { allowedCorsOrigins: ['https://a.example\r\nMARK: 1'] }, ORIGIN],
      ['cors 2 KB', { allowedCorsOrigins: [KB2] }, ORIGIN],
      ['cors jwt', { allowedCorsOrigins: [JWTISH] }, ORIGIN],
      ['cors html http', { allowedCorsOrigins: ['http://mark.example'] }, ORIGIN_HTTPS],
      ['cors ftp', { allowedCorsOrigins: ['ftp://mark.example'] }, ORIGIN_HTTPS],
      ['resources secret', { allowedResources: ['api', SECRET] }, UNKNOWN],
      ['resources CRLF', { allowedResources: ['MARK\r\nX: y'] }, UNKNOWN],
      ['resources 2 KB', { allowedResources: [KB2] }, UNKNOWN],
      ['resources html', { allowedResources: ['<script>MARK</script>'] }, UNKNOWN],
    ];
    const NEEDLES = ['MARK', 'sk_live', 'eyJhbGci', 'evil', '<script', 'QQQQQQQQ', 'onerror'];
    const expectFixed = (res: InjectResponse, message: string, from: number) => {
      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.json()).toEqual({ error: 'invalid_request', error_description: message });
      for (const n of NEEDLES) expect(res.body).not.toContain(n);
      const logs = pino.slice(from).join('\n');
      for (const n of NEEDLES) expect(logs).not.toContain(n);
    };

    it.each(cases)('POST %s => 400 fixed message, no echo, nothing stored', async (_l, over, m) => {
      const clients0 = await clientModel.countDocuments({});
      const from = pino.length;
      expectFixed(await call('POST', '/admin/clients', publicClient(over), ids.tenantA), m, from);
      expect(await clientModel.countDocuments({})).toBe(clients0);
    });

    it.each(cases)('PATCH %s => 400 fixed message, no echo, DB unchanged', async (_l, over, m) => {
      const clientId = await mkClient();
      const before = await clientDoc(clientId);
      const from = pino.length;
      expectFixed(await call('PATCH', `/admin/clients/${clientId}`, over, ids.tenantA), m, from);
      expect(await clientDoc(clientId)).toEqual(before);
      expect(await countAudits('ADMIN_CLIENT_UPDATED', clientId)).toBe(0);
    });

    it('characterization DEBT-548: a redirect URI with raw CR/LF/TAB in the path is accepted and stored raw (WHATWG URL strips them before the checks)', async () => {
      for (const v of [
        'https://app.example.com/cb\r\nSet-Cookie: x=1',
        'https://app.example.com/c\tb',
      ]) {
        const r = await call(
          'POST',
          '/admin/clients',
          publicClient({ redirectUris: [v] }),
          ids.tenantA,
        );
        expect(r.statusCode).toBe(201);
        expect((await clientDoc(r.json().clientId as string))?.redirectUris).toEqual([v]);
      }
    });

    it('pino captured the requests at all (the no-echo log assertions are not vacuous)', () => {
      expect(pino.some((l) => l.includes('/admin/clients'))).toBe(true);
    });

    it('an over-long value (> 2048) is still rejected by the DTO, not echoed', async () => {
      const from = pino.length;
      const res = await call(
        'POST',
        '/admin/clients',
        publicClient({ redirectUris: [`https://a.example/${'MARK'.repeat(600)}`] }),
        ids.tenantA,
      );
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain('MARK');
      expect(pino.slice(from).join('\n')).not.toContain('MARK');
    });
  });

  // ------------------------------------------------------------------ T3 DEBT-537

  describe('T3 DEBT-537: $-strings, dotted strings, stored shapes, concurrency', () => {
    const patch = (resourceId: string, body: unknown) =>
      call('PATCH', `/admin/resources/${resourceId}`, body);
    const audits = (resourceId: string) => countAudits('ADMIN_RESOURCE_UPDATED', resourceId);

    const DOLLAR = [
      ['$$ROOT'],
      ['$$REMOVE'],
      ['$scopes'],
      ['$identifier'],
      ['$$CURRENT.scopes'],
      ['a.b'],
      ['$a.b', 'c'],
      ['$'],
      ['$$'],
    ];

    it.each(DOLLAR.map((e) => [JSON.stringify(e), e]))(
      'stored %s literally + same expectedScopes => 200',
      async (_l, e) => {
        const rid = await mkResource(e);
        const res = await patch(rid, { scopes: ['x'], expectedScopes: e });
        expect(res.statusCode).toBe(200);
        expect(await storedScopes(rid)).toEqual(['x']);
        expect(await audits(rid)).toBe(1);
      },
    );

    it.each([
      ['[] vs $$REMOVE', [], ['$$REMOVE']],
      ['null vs $$REMOVE', null, ['$$REMOVE']],
      ['absent vs $$REMOVE', 'unset', ['$$REMOVE']],
      ['[x] vs $scopes', ['x'], ['$scopes']],
      ['[R-identifier] vs $identifier', 'IDENT', ['$identifier']],
      ['[a.b] vs $a.b', ['a.b'], ['$a.b']],
    ] as Array<[string, unknown, string[]]>)(
      'stored %s => 409 (never a path/variable)',
      async (_l, raw, expected) => {
        let rid: string;
        if (raw === 'IDENT') {
          rid = await mkResource([]);
          await resourceModel.updateOne(
            { resourceId: rid },
            { $set: { scopes: [`https://${rid}.example.com/`] } },
          );
        } else rid = await mkResource(raw);
        const before = await storedScopes(rid);
        const res = await patch(rid, { scopes: ['x'], expectedScopes: expected });
        expect(res.statusCode).toBe(409);
        expect(res.body).toBe(CONFLICT_BODY);
        expect(await storedScopes(rid)).toEqual(before);
        expect(await audits(rid)).toBe(0);
      },
    );

    // Matrix stored × expected over the shapes the admin view can produce.
    const STORED: Array<[string, unknown, string[]]> = [
      ['null', null, []],
      ['absent', 'unset', []],
      ['[]', [], []],
      ['[null]', [null], ['?']],
      ["['a',null]", ['a', null], ['?']],
      ["['a']", ['a'], ['a']],
      [`legacy ${JSON.stringify(LEGACY)}`, [LEGACY], [LEGACY]],
    ];
    const EXPECTED: string[][] = [[], ['a'], ['a', 'a'], [LEGACY]];
    const matrix = STORED.flatMap(([sl, raw, view]) =>
      EXPECTED.map(
        (e) =>
          [`${sl} vs ${JSON.stringify(e)}`, raw, e, JSON.stringify(view) === JSON.stringify(e)] as [
            string,
            unknown,
            string[],
            boolean,
          ],
      ),
    );
    it.each(matrix)('stored %s', async (_l, raw, expected, match) => {
      const rid = await mkResource(raw);
      const before = await resourceModel.findOne({ resourceId: rid }).lean();
      const res = await patch(rid, { scopes: ['x'], expectedScopes: expected });
      if (match) {
        expect(res.statusCode).toBe(200);
        expect(await storedScopes(rid)).toEqual(['x']);
        expect(await audits(rid)).toBe(1);
      } else {
        expect(res.statusCode).toBe(409);
        expect(res.body).toBe(CONFLICT_BODY);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(await resourceModel.findOne({ resourceId: rid }).lean()).toEqual(before);
        expect(await audits(rid)).toBe(0);
      }
    });

    it('hostile expectedScopes shapes => 400 before the service (null, [null], object, nested, 51 items)', async () => {
      const rid = await mkResource(null);
      for (const e of [
        null,
        [null],
        { $ne: [] },
        [{ $gt: '' }],
        [['a']],
        'a',
        [''],
        Array.from({ length: 51 }, (_, i) => `s${i}`),
      ]) {
        const res = await patch(rid, { scopes: ['x'], expectedScopes: e });
        expect(res.statusCode).toBe(400);
      }
      expect(await storedScopes(rid)).toBeNull();
      expect(await audits(rid)).toBe(0);
    });

    it.each([
      ['null', null],
      ['absent', 'unset'],
    ])(
      '12 parallel PATCHes on a %s-stored resource with expectedScopes [] => exactly 1 x 200, 11 x 409',
      async (_l, raw) => {
        const rid = await mkResource(raw);
        const results = await Promise.all(
          Array.from({ length: 12 }, (_, i) =>
            patch(rid, { scopes: [`c${i}`], expectedScopes: [] }),
          ),
        );
        const ok = results.map((r, i) => [r.statusCode, i] as const).filter(([s]) => s === 200);
        expect(ok).toHaveLength(1);
        for (const r of results.filter((x) => x.statusCode !== 200)) {
          expect(r.statusCode).toBe(409);
          expect(r.body).toBe(CONFLICT_BODY);
        }
        expect(await storedScopes(rid)).toEqual([`c${ok[0][1]}`]);
        expect(await audits(rid)).toBe(1);
      },
    );
  });
});
