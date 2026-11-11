import { jest } from '@jest/globals';
import type { Model } from 'mongoose';
import { KEY_PROVIDER, type KeyProvider } from '../src/modules/keys/key-provider';
import { FederatedIdentityService } from '../src/modules/identity/federated-identity.service';
import { UserService } from '../src/modules/identity/user.service';
import { FederationError } from '../src/modules/federation/federation.errors';
import { FederationService } from '../src/modules/federation/federation.service';
import { bootFullApp, type FullApp, type InjectResponse } from './full-app';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';

/**
 * Run 84 tester (adversarial, T1/T2 + checklist evidence) on the REAL app:
 * - D84.1 is checked on the RAW string: Unicode look-alikes / NFKC-foldable forms / a character whose
 *   `toLowerCase()` is ASCII never pass, on the HTTP boundary or on the federation F5 path;
 * - type confusion (array / Mongo operator object) on `/register`, `/forgot`, `/login` => 400, nothing
 *   written, no mail (ASVS V1.2.4 evidence for the checklist);
 * - mixed case is a VALID address (normalised to lower case afterwards, one mail);
 * - federation F5 refuses BEFORE `findByEmail` (spy proof) and after `findByProvider`;
 * - `/jwks.json`: a conditional request never gets a 304, a non-dependency failure stays `no-store`;
 * - HSTS >= 1 year (ASVS 3.4.1, L1) and a charset on JSON/HTML (ASVS 4.1.1, L1).
 */
const PASSWORD = 'correct horse battery';

/** Not deliverable under D84.1 although some normalisation would make them ASCII. */
const CONFUSABLE: Array<[string, string]> = [
  ['fullwidth domain letter (NFKC => g)', 'victim@ｇood.test'],
  ['fullwidth at sign (NFKC => @)', 'victim＠good.test'],
  ['ligature fi in domain (NFKC => fi)', 'victim@ﬁnance.test'],
  ['one dot leader in domain (NFKC => .)', 'victim@good․test'],
  ['Kelvin sign local (toLowerCase => k)', 'Kelvin@good.test'],
  ['Cyrillic o in domain', 'victim@gооd.test'],
  ['dotted capital I (toLowerCase => i + U+0307)', 'vİctim@good.test'],
  ['zero width space in local', 'vic​tim@good.test'],
];

describe('run 84 tester: D84.1 raw-string grammar, type confusion, federation order, JWKS edges, headers', () => {
  let full: FullApp;
  let userModel: Model<Record<string, unknown>>;
  let verifyModel: Model<Record<string, unknown>>;
  let resetModel: Model<Record<string, unknown>>;

  const boot = async (): Promise<void> => {
    full = await bootFullApp({ name: 'run84-tester' });
    userModel = full.conn.model<Record<string, unknown>>('User');
    verifyModel = full.conn.model<Record<string, unknown>>('EmailVerificationToken');
    resetModel = full.conn.model<Record<string, unknown>>('PasswordResetToken');
  };
  let setup: Promise<void> | undefined;
  beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await settled(setup);
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);
  afterEach(() => jest.restoreAllMocks());

  /** GET the form (CSRF cookie + token), then POST `payload` from the same "browser". */
  async function post(
    path: '/register' | '/forgot' | '/login',
    fields: Record<string, unknown>,
    as: 'json' | 'form' = 'json',
  ): Promise<InjectResponse> {
    const page = await full.app.inject({ method: 'GET', url: path });
    expect(page.statusCode).toBe(200);
    const csrf = page.body.match(/name="_csrf" value="([^"]+)"/)![1];
    const cookies = Object.fromEntries(page.cookies.map((c) => [c.name, c.value]));
    const res =
      as === 'json'
        ? await full.app.inject({
            method: 'POST',
            url: path,
            cookies,
            payload: { _csrf: csrf, ...fields },
          })
        : await full.app.inject({
            method: 'POST',
            url: path,
            cookies,
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            payload: [
              `_csrf=${encodeURIComponent(csrf)}`,
              ...Object.entries(fields).flatMap(([k, v]) =>
                (Array.isArray(v) ? v : [v]).map(
                  (x) => `${encodeURIComponent(k)}=${encodeURIComponent(String(x))}`,
                ),
              ),
            ].join('&'),
          });
    await new Promise((r) => setImmediate(r)); // fire-and-forget mail lands in the outbox first
    return res as InjectResponse;
  }

  const totals = async () => ({
    users: await userModel.countDocuments({}),
    verify: await verifyModel.countDocuments({}),
    reset: await resetModel.countDocuments({}),
    mails: full.outbox.length,
  });

  const expectGeneric400 = (res: InjectResponse) => {
    expect(res.statusCode).toBe(400);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('The request could not be completed.');
    expect(res.body).not.toContain('good.test');
    expect(res.body).not.toContain('evil.test');
  };

  it.each(CONFUSABLE)(
    'T1-a %s: /register and /forgot => 400, 0 user, 0 token, 0 mail (raw string checked, no folding)',
    async (_n, email) => {
      // A legacy row with the folded form exists, so a folding bug would also send a reset mail.
      await full.app
        .get(UserService)
        .createWithPasswordHash(email.normalize('NFKC'), 'legacy-hash')
        .catch(() => undefined);
      const before = await totals();
      expectGeneric400(await post('/register', { email, password: PASSWORD }));
      expectGeneric400(await post('/forgot', { email }));
      expect(await totals()).toEqual(before);
    },
  );

  it.each([
    [
      'JSON array (valid first, hostile second)',
      ['ok.run84t@example.com', '"x>a@evil.test"@good.test'],
      'json',
    ],
    [
      'form-urlencoded repeated email',
      ['ok.run84t@example.com', '"x>a@evil.test"@good.test'],
      'form',
    ],
    ['Mongo operator $ne', { $ne: null }, 'json'],
    ['Mongo operator $gt', { $gt: '' }, 'json'],
    ['Mongo operator $regex', { $regex: '.*' }, 'json'],
  ] as Array<[string, unknown, 'json' | 'form']>)(
    'T1-b type confusion %s on /register, /forgot, /login => 400, nothing written, no mail, no session',
    async (_n, email, as) => {
      const before = await totals();
      for (const path of ['/register', '/forgot', '/login'] as const) {
        const res = await post(path, { email, password: PASSWORD }, as);
        expect(res.statusCode).toBe(400);
        expect(String(res.headers['set-cookie'] ?? '')).not.toMatch(/idp_session=/);
        expect(res.body).not.toContain('evil.test');
      }
      expect(await totals()).toEqual(before);
    },
  );

  it('T1-c mixed case is valid: register => 201 + 1 verify mail to the lower-cased address; forgot in another case => 1 reset mail', async () => {
    const stamp = Date.now();
    const typed = `Run84T.Mixed+Tag${stamp}@Sub.Example.COM`;
    const stored = typed.toLowerCase();
    const before = await totals();
    const reg = await post('/register', { email: typed, password: PASSWORD });
    expect(reg.statusCode).toBe(201);
    expect(await userModel.countDocuments({ email: stored })).toBe(1);
    expect(full.outbox.at(-1)!.to).toBe(stored);
    const forgot = await post('/forgot', { email: `RUN84T.MIXED+TAG${stamp}@sub.example.com` });
    expect(forgot.statusCode).toBe(201);
    expect(full.outbox.at(-1)!.to).toBe(stored);
    expect(await totals()).toEqual({
      users: before.users + 1,
      verify: before.verify + 1,
      reset: before.reset + 1,
      mails: before.mails + 2,
    });
  });

  describe('T1-d federation F5 (service on the real app): grammar before any lookup by email', () => {
    type Resolve = (
      provider: 'google' | 'github',
      identity: { providerId: string; email?: string },
      audit: Record<string, string>,
    ) => Promise<{ userId: string; newUser: boolean; link?: true }>;
    const resolve = (providerId: string, email: string) =>
      (full.app.get(FederationService) as unknown as { resolveUser: Resolve }).resolveUser.call(
        full.app.get(FederationService),
        'google',
        { providerId, email },
        { ip: '127.0.0.1', requestId: 'run84-tester' },
      );

    it.each([
      ...CONFUSABLE,
      ['leading space (trim would fix it)', ' victim@good.test'],
      ['trailing LF', 'victim@good.test\n'],
      ['DEBT-556 quoted', '"x>attacker@evil.test"@good.test'],
    ])(
      '%s => email_unverified; findByProvider ran, findByEmail never ran, 0 user',
      async (_n, email) => {
        // A local account under the folded/trimmed form exists: a lookup would find it.
        await full.app
          .get(UserService)
          .createWithPasswordHash(email.normalize('NFKC').trim(), 'legacy-hash')
          .catch(() => undefined);
        const byProvider = jest.spyOn(full.app.get(FederatedIdentityService), 'findByProvider');
        const byEmail = jest.spyOn(full.app.get(UserService), 'findByEmail');
        const users = await userModel.countDocuments({});
        const providerId = `run84t-${Math.random().toString(36).slice(2)}`;
        const err = await resolve(providerId, email).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(FederationError);
        expect((err as FederationError).code).toBe('email_unverified');
        expect(byProvider).toHaveBeenCalledTimes(1);
        expect(byEmail).not.toHaveBeenCalled();
        expect(await userModel.countDocuments({})).toBe(users);
      },
    );

    it('control: a mixed-case valid email IS looked up (lower-cased) and an existing local account answers link', async () => {
      const stored = `run84t.fed.${Date.now()}@example.com`;
      const local = await full.app.get(UserService).createWithPasswordHash(stored, 'legacy-hash');
      const byEmail = jest.spyOn(full.app.get(UserService), 'findByEmail');
      const out = await resolve(
        `run84t-ok-${Date.now()}`,
        stored.replace('run84t.fed', 'Run84T.Fed').toUpperCase(),
      );
      expect(byEmail).toHaveBeenCalledWith(stored);
      expect(out).toEqual({ userId: local.sub, newUser: false, link: true });
    });
  });

  describe('T2 /jwks.json edges', () => {
    it.each([
      ['If-None-Match *', { 'if-none-match': '*' }],
      ['If-None-Match with a guessed tag', { 'if-none-match': 'W/"stale"' }],
      ['If-Modified-Since in the future', { 'if-modified-since': 'Fri, 01 Jan 2100 00:00:00 GMT' }],
    ])(
      'T2-a conditional GET (%s) => 200 with the current keys, no-cache, never 304',
      async (_n, headers) => {
        const res = await full.app.inject({ method: 'GET', url: '/jwks.json', headers });
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe('no-cache');
        expect((res.json() as { keys: unknown[] }).keys.length).toBeGreaterThan(0);
      },
    );

    it('T2-b a non-dependency failure of the key provider => 5xx no-store (never no-cache), no detail', async () => {
      jest
        .spyOn(full.app.get<KeyProvider>(KEY_PROVIDER), 'getPublicKeys')
        .mockRejectedValue(new Error('boom SECRET-DETAIL'));
      const res = await full.app.inject({ method: 'GET', url: '/jwks.json' });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).not.toContain('SECRET-DETAIL');
      expect(res.body).not.toContain('boom');
    });
  });

  describe('checklist evidence: transport headers', () => {
    it.each(['/jwks.json', '/login', '/.well-known/openid-configuration'])(
      'ASVS 3.4.1: %s carries HSTS max-age >= 1 year (31536000 s)',
      async (url) => {
        const res = await full.app.inject({ method: 'GET', url });
        const m = /max-age=(\d+)/.exec(String(res.headers['strict-transport-security'] ?? ''));
        expect(Number(m?.[1] ?? 0)).toBeGreaterThanOrEqual(31536000);
      },
    );

    it.each(['/', '/jwks.json', '/login'])(
      'ASVS 13.4.4: TRACE %s => not 2xx, request headers never echoed',
      async (url) => {
        const res = await full.app.inject({
          method: 'TRACE',
          url,
          headers: { 'x-run84-probe': 'trace-echo-marker' },
        });
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(res.body).not.toContain('trace-echo-marker');
      },
    );

    it('ASVS 4.1.1: JSON and HTML responses declare a charset matching the body', async () => {
      const json = await full.app.inject({ method: 'GET', url: '/jwks.json' });
      expect(String(json.headers['content-type'])).toMatch(/^application\/json; charset=utf-8$/i);
      const html = await full.app.inject({ method: 'GET', url: '/login' });
      expect(String(html.headers['content-type'])).toMatch(/^text\/html; charset=utf-8$/i);
    });
  });
});
