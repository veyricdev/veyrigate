import { jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import IORedis from 'ioredis';
import { randomBytes, randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { deriveS256Challenge } from '../src/common/crypto/pkce.util';
import { sha256, verifyPassword } from '../src/common/crypto/crypto.util';
import { RedisService } from '../src/database/redis/redis.service';
import { AuthenticationService } from '../src/modules/authentication/authentication.service';
import { COMMON_PASSWORD_MESSAGE } from '../src/modules/authentication/password-policy/password-policy';
import { FederationStateStore } from '../src/modules/federation/federation-state.store';
import { FederationService } from '../src/modules/federation/federation.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { UserService } from '../src/modules/identity/user.service';
import { AuditAction } from '../src/modules/security/audit/audit-action.enum';
import { SESSION_COOKIE } from '../src/modules/sessions/session.cookie';
import { SessionService } from '../src/modules/sessions/session.service';
import {
  authorizeCode,
  bootFullApp,
  FLOW_API_AUD,
  FLOW_REDIRECT,
  formPost,
  seedFlowClient,
  type FullApp,
  type InjectResponse,
} from './full-app';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';
import { seedConsent } from './oauth-fixtures';

/**
 * Run 85 T6 — tester probes on the REAL app that the dev specs (run85-*.int-spec.ts) do not cover.
 * Risk matrix (see runs/85-X6-release2/log.md, tester line):
 * - Credential: device cookie absent / forged / malformed / oversized / stale; replayed after reset.
 * - Identity: existing vs unknown email (429 parity incl. the account bucket and the cookie path).
 * - State: password change racing a login with the OLD password, a reset, and a second change.
 * - Input: NFKC / case variants of a common password and of the email local part; odd encodings
 *   of `request_uri`; `POST /userinfo` with JSON / oversized bodies and the token outside the header.
 */
const PASSWORD = 'r85t-Current#Pass-1';
const NEW_PASSWORD = 'r85t-Brand#New-Pass-2';
const OTHER_PASSWORD = 'r85t-Other#New-Pass-3';
const WRONG = 'r85t-wrong-password-99';
const THROTTLED_TEXT = 'Too many sign-in attempts. Try again later or reset your password.';

type Res = InjectResponse;

const setCookies = (res: InjectResponse): string[] =>
  ([] as string[]).concat((res.headers['set-cookie'] as string | string[] | undefined) ?? []);
const pairOf = (res: InjectResponse, name: string) =>
  setCookies(res)
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0];
const csrfOf = (res: InjectResponse): string => res.body.match(/name="_csrf" value="([^"]+)"/)![1];

/** A deferred: `wait` resolves once `open()` is called. */
const gate = () => {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
};

describe('run 85 T6 tester probes (real app, http)', () => {
  let full: FullApp;
  let redis: IORedis;
  let bff: { clientId: string; secret: string };

  const boot = async (): Promise<void> => {
    full = await bootFullApp({ name: 'run85-tester' });
    redis = new IORedis(full.env.REDIS_URL, { maxRetriesPerRequest: 1 });
    bff = await seedFlowClient(full);
  };
  let setup: Promise<void> | undefined;
  beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await settled(setup);
    redis?.disconnect();
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);
  afterEach(() => jest.restoreAllMocks());

  let ipSeq = 0;
  /** A fresh documentation-range IPv4 per call (own (email, network) bucket). */
  const ip = () => {
    ipSeq++;
    return `203.0.${Math.floor(ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
  };

  const newUser = async (password: string | null = PASSWORD, local = `r85t-${randomUUID()}`) => {
    const email = `${local}@fixture.test`;
    const users = full.app.get(UserService);
    const u = await users.create({ email, ...(password ? { password } : {}) });
    await users.verifyEmail(u.sub);
    await full.conn
      .model('UserTenant')
      .create({ userId: new Types.ObjectId(u.sub), tenantId: DEFAULT_TENANT_ID, status: 'active' });
    return { email, sub: u.sub };
  };

  /** GET /login then POST /login from `from`, with a raw extra cookie header part. */
  const login = async (
    email: string,
    password: string,
    from = ip(),
    extraCookie?: string,
  ): Promise<{ res: Res; session?: string; device?: string; jar: string }> => {
    const page = (await full.app.inject({
      method: 'GET',
      url: '/login',
      remoteAddress: from,
    })) as Res;
    const anon = pairOf(page, 'idp_csrf')!;
    const res = (await full.app.inject({
      method: 'POST',
      url: '/login',
      remoteAddress: from,
      headers: { cookie: [anon, ...(extraCookie !== undefined ? [extraCookie] : [])].join('; ') },
      payload: { _csrf: csrfOf(page), email, password, returnTo: '/' },
    })) as Res;
    const session = pairOf(res, 'idp_session');
    const device = pairOf(res, 'idp_dc');
    return { res, session, device, jar: [session, device].filter(Boolean).join('; ') };
  };
  const valueOf = (pair?: string) => pair?.slice(pair.indexOf('=') + 1);

  const change = async (jar: string, current: string, next: string) => {
    const form = (await full.app.inject({
      method: 'GET',
      url: '/account/password',
      headers: { cookie: jar },
    })) as Res;
    return full.app.inject({
      method: 'POST',
      url: '/account/password',
      headers: { cookie: jar },
      payload: { _csrf: csrfOf(form), current_password: current, new_password: next },
    }) as Promise<Res>;
  };

  const hashOf = async (sub: string) =>
    (
      await full.conn
        .model('User')
        .findById(sub)
        .select('+passwordHash')
        .lean<{ passwordHash?: string }>()
        .exec()
    )?.passwordHash;
  const flushMail = () => new Promise((resolve) => setImmediate(resolve));
  const resetTokenFor = async (email: string): Promise<string> => {
    await full.app.get(AuthenticationService).forgotPassword(email);
    await flushMail();
    const link = full.outbox.filter((m) => m.to === email).at(-1)!;
    return new URL(link.text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
  };
  const trustKey = (sub: string) => `dc:{u:${sha256(sub)}}`;
  const zscoreSpy = () => jest.spyOn(full.app.get(RedisService).client, 'zscore');

  // ------------------------------------------------------------- device cookie (credential axis)

  describe('device cookie forged / malformed / oversized / stale', () => {
    it.each<[string, string]>([
      ['42 chars', 'A'.repeat(42)],
      ['44 chars', 'A'.repeat(44)],
      ['43 chars with "."', `${'A'.repeat(42)}.`],
      ['43 chars with "+"', `${'A'.repeat(42)}+`],
      ['43 chars with "/"', `${'A'.repeat(42)}/`],
      ['non-ASCII (43 x é, percent-encoded)', encodeURIComponent('é'.repeat(43))],
      ['broken percent escape', `${'A'.repeat(40)}%E0%A4%A`],
      ['oversized (4000 chars)', 'A'.repeat(4000)],
      ['empty', ''],
      ['JSON-looking', encodeURIComponent('{"$gt":""}')],
    ])(
      'cookie %s: no 500, never looked up, a correct password still signs in with a FRESH token',
      async (_label, raw) => {
        const u = await newUser();
        const zscore = zscoreSpy();
        const ok = await login(u.email, PASSWORD, ip(), `idp_dc=${raw}`);
        expect(ok.res.statusCode).toBe(302);
        expect(ok.session).toBeDefined();
        expect(zscore).not.toHaveBeenCalled();
        const issued = valueOf(ok.device)!;
        expect(issued).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(issued).not.toBe(raw);
        expect(await redis.zcard(trustKey(u.sub))).toBe(1);
        // A wrong password with the same junk cookie is charged as an UNTRUSTED device (N = 5).
        const from = ip();
        for (let i = 0; i < 5; i++) {
          expect((await login(u.email, WRONG, from, `idp_dc=${raw}`)).res.statusCode).toBe(401);
        }
        const sixth = await login(u.email, WRONG, from, `idp_dc=${raw}`);
        expect(sixth.res.statusCode).toBe(429);
        expect(sixth.res.body).toContain(THROTTLED_TEXT);
      },
    );

    it('a percent-encoded spelling of a trusted token is the same cookie (decoded once), still trusted', async () => {
      const u = await newUser();
      const first = await login(u.email, PASSWORD);
      const token = valueOf(first.device)!;
      // Fill the account bucket so only the trusted-device path can sign in.
      for (let i = 0; i < 20; i++) await login(u.email, WRONG, `198.18.40.${i % 5}`);
      const encoded = token.replace(/A/g, '%41').replace(/-/g, '%2D');
      const res = await login(u.email, PASSWORD, ip(), `idp_dc=${encoded}`);
      expect(res.res.statusCode).toBe(302);
      // ...and the presented token is rotated out (D85.11).
      expect(await redis.zscore(trustKey(u.sub), sha256(token))).toBeNull();
    });

    it('a trusted entry older than 90 days is not trusted any more (account bucket applies)', async () => {
      const u = await newUser();
      const first = await login(u.email, PASSWORD);
      const token = valueOf(first.device)!;
      for (let i = 0; i < 20; i++) await login(u.email, WRONG, `198.18.41.${i % 5}`);
      await redis.zadd(trustKey(u.sub), String(Date.now() - 91 * 24 * 3600 * 1000), sha256(token));
      const stale = await login(u.email, PASSWORD, ip(), `idp_dc=${token}`);
      expect(stale.res.statusCode).toBe(429);
      expect(stale.session).toBeUndefined();
      // Control: the same entry refreshed to "now" is trusted again.
      await redis.zadd(trustKey(u.sub), String(Date.now()), sha256(token));
      expect((await login(u.email, PASSWORD, ip(), `idp_dc=${token}`)).res.statusCode).toBe(302);
    });

    it('trusted-device failures (D = 10) are charged neither to the network nor to the account bucket', async () => {
      const u = await newUser();
      const token = valueOf((await login(u.email, PASSWORD)).device)!;
      const from = ip();
      for (let i = 0; i < 10; i++) {
        expect((await login(u.email, WRONG, from, `idp_dc=${token}`)).res.statusCode).toBe(401);
      }
      const eleventh = await login(u.email, WRONG, from, `idp_dc=${token}`);
      expect(eleventh.res.statusCode).toBe(429);
      const throttled = await full.conn
        .model('AuditLog')
        .find({ action: AuditAction.AUTH_LOGIN_THROTTLED, targetId: u.sub })
        .lean<Array<{ metadata?: { scope?: string } }>>()
        .exec();
      expect(throttled.map((a) => a.metadata?.scope)).toEqual(['device']);
      // Same network, no cookie: the 10 device failures did not touch N or A.
      expect((await login(u.email, PASSWORD, from)).res.statusCode).toBe(302);
    });

    it('a device cookie that was trusted before a password reset is not trusted after it', async () => {
      const u = await newUser();
      const token = valueOf((await login(u.email, PASSWORD)).device)!;
      await full.app
        .get(AuthenticationService)
        .resetPassword(await resetTokenFor(u.email), NEW_PASSWORD);
      for (let i = 0; i < 20; i++) await login(u.email, WRONG, `198.18.42.${i % 5}`);
      // Replay of the old cookie with the NEW password: untrusted => account bucket => 429.
      const replay = await login(u.email, NEW_PASSWORD, ip(), `idp_dc=${token}`);
      expect(replay.res.statusCode).toBe(429);
      expect(replay.session).toBeUndefined();
    });
  });

  // --------------------------------------------------------------- 429 parity (identity axis)

  describe('429 parity: existing vs unknown email', () => {
    const comparable = (res: Res) => {
      const h = { ...res.headers };
      for (const k of ['date', 'x-request-id', 'request-id', 'set-cookie', 'retry-after'])
        delete h[k];
      return {
        status: res.statusCode,
        body: res.body.replace(/name="_csrf" value="[^"]+"/g, ''),
        headers: h,
        cookieNames: setCookies(res)
          .map((c) => c.split('=')[0])
          .sort(),
        retryAfterPositive: Number(res.headers['retry-after']) > 0,
      };
    };

    it('account bucket (20 over 5 networks, 21st from a new network): identical 429 status/body/headers', async () => {
      const existing = await newUser();
      const ghost = `r85t-ghost-${randomUUID()}@fixture.test`;
      const run = async (email: string, octet: number) => {
        for (let i = 0; i < 20; i++) await login(email, WRONG, `198.18.${octet}.${i % 5}`);
        return login(email, WRONG, `198.18.${octet}.200`);
      };
      const a = await run(existing.email, 50);
      const b = await run(ghost, 51);
      expect(a.res.statusCode).toBe(429);
      expect(comparable(a.res)).toEqual(comparable(b.res));
      // Exposure: the throttle audit of the unknown email carries no target and no address.
      const docs = await full.conn
        .model('AuditLog')
        .find({ action: AuditAction.AUTH_LOGIN_THROTTLED, 'metadata.scope': 'account' })
        .lean<Array<Record<string, unknown>>>()
        .exec();
      const ghostDocs = docs.filter((d) => d.targetId === undefined);
      expect(ghostDocs.length).toBeGreaterThanOrEqual(1);
      for (const d of docs) expect(JSON.stringify(d)).not.toContain('@fixture.test');
    });

    it('throttled with a well-formed device cookie: same responses and the same trust lookups', async () => {
      const existing = await newUser();
      const ghost = `r85t-ghost-${randomUUID()}@fixture.test`;
      const cookie = `idp_dc=${'R'.repeat(43)}`;
      const from = ['198.18.60.1', '198.18.61.1'];
      const sixth = async (email: string, at: string) => {
        for (let i = 0; i < 5; i++) await login(email, WRONG, at, cookie);
        const zscore = zscoreSpy();
        const res = await login(email, WRONG, at, cookie);
        const calls = zscore.mock.calls.length;
        zscore.mockRestore();
        return { res, calls };
      };
      const a = await sixth(existing.email, from[0]);
      const b = await sixth(ghost, from[1]);
      expect(a.res.res.statusCode).toBe(429);
      expect(comparable(a.res.res)).toEqual(comparable(b.res.res));
      expect(a.calls).toBe(1);
      expect(b.calls).toBe(a.calls);
    });
  });

  // ------------------------------------------------------------ password change races (state)

  describe('password change / reset vs concurrent work', () => {
    /**
     * Interleave: an attacker who knows the OLD password is inside `/login` (Argon2 already said
     * yes) when the owner changes (or resets) the password; the attacker's session is created only
     * AFTER the revoke sweep. Invariant (D85.6, INV-28 family, §9.8): after a credential change no
     * session established with the old password may stay live.
     */
    it.each<['change' | 'reset']>([['change'], ['reset']])(
      'a login with the OLD password racing a password %s must not leave a live session',
      async (kind) => {
        const u = await newUser();
        const owner = await login(u.email, PASSWORD);
        const sessions = full.app.get(SessionService);
        const establishReached = gate();
        const release = gate();
        const real = sessions.establish.bind(sessions);
        jest.spyOn(sessions, 'establish').mockImplementationOnce(async (...args) => {
          establishReached.open();
          await release.wait;
          return real(...args);
        });
        const attacker = login(u.email, PASSWORD);
        await establishReached.wait; // the old password has been verified
        if (kind === 'change') {
          const res = await change(owner.jar, PASSWORD, NEW_PASSWORD);
          expect(res.statusCode).toBe(200);
        } else {
          await full.app
            .get(AuthenticationService)
            .resetPassword(await resetTokenFor(u.email), NEW_PASSWORD);
        }
        release.open();
        const a = await attacker;
        const sid = valueOf(a.session);
        const live = sid ? await sessions.get(sid) : null;
        expect({ status: a.res.statusCode, liveSession: live !== null }).toEqual({
          status: 401,
          liveSession: false,
        });
      },
    );

    it('change and reset at the same time: one final password, no 5xx, every session dead', async () => {
      const u = await newUser();
      const s = await login(u.email, PASSWORD);
      const token = await resetTokenFor(u.email);
      const [changed, reset] = await Promise.allSettled([
        change(s.jar, PASSWORD, NEW_PASSWORD),
        full.app.get(AuthenticationService).resetPassword(token, OTHER_PASSWORD),
      ]);
      expect(changed.status).toBe('fulfilled');
      expect(reset.status).toBe('fulfilled');
      const changeStatus = (changed as PromiseFulfilledResult<Res>).value.statusCode;
      expect([200, 409]).toContain(changeStatus);
      const hash = (await hashOf(u.sub))!;
      const matches = [
        await verifyPassword(hash, NEW_PASSWORD),
        await verifyPassword(hash, OTHER_PASSWORD),
      ];
      expect(matches.filter(Boolean)).toHaveLength(1);
      expect(await full.app.get(SessionService).get(valueOf(s.session)!)).toBeNull();
      expect(await redis.exists(trustKey(u.sub))).toBe(0);
    });

    it('two concurrent changes from one session: exactly one success, one success audit', async () => {
      const u = await newUser();
      const s = await login(u.email, PASSWORD);
      const results = await Promise.all([
        change(s.jar, PASSWORD, NEW_PASSWORD),
        change(s.jar, PASSWORD, OTHER_PASSWORD),
      ]);
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes.filter((c) => c === 200)).toHaveLength(1);
      // The loser sees a fixed refusal (conflict / stale current / dead session), never a 5xx.
      expect(codes.every((c) => c < 500)).toBe(true);
      const hash = (await hashOf(u.sub))!;
      const matches = [
        await verifyPassword(hash, NEW_PASSWORD),
        await verifyPassword(hash, OTHER_PASSWORD),
      ];
      expect(matches.filter(Boolean)).toHaveLength(1);
      const ok = await full.conn
        .model('AuditLog')
        .find({ action: AuditAction.AUTH_PASSWORD_CHANGED, actorId: u.sub, result: 'success' })
        .countDocuments()
        .exec();
      expect(ok).toBe(1);
    });
  });

  describe('federation /auth/link vs a concurrent password change', () => {
    it('a link login with the OLD password racing a password change: not linked, the new session is dead', async () => {
      const u = await newUser();
      const owner = await login(u.email, PASSWORD);
      const binding = randomBytes(32).toString('base64url');
      const providerId = `r85t-google-${randomUUID()}`;
      const linkToken = await full.app.get(FederationStateStore).createLink({
        provider: 'google',
        providerId,
        email: u.email,
        userId: u.sub,
        requestId: randomBytes(16).toString('hex'),
        bindingHash: sha256(binding),
      });
      const sessions = full.app.get(SessionService);
      const establishReached = gate();
      const release = gate();
      const real = sessions.establish.bind(sessions);
      const established: string[] = [];
      jest.spyOn(sessions, 'establish').mockImplementationOnce(async (...args) => {
        establishReached.open();
        await release.wait;
        const out = await real(...args);
        established.push(out.id);
        return out;
      });
      const linking = full.app.get(FederationService).completeLink(linkToken, binding, PASSWORD, {
        ip: ip(),
        userAgent: 'r85t',
        requestId: 'r85t-link',
      });
      await establishReached.wait; // the old password has been verified inside the link
      expect((await change(owner.jar, PASSWORD, NEW_PASSWORD)).statusCode).toBe(200);
      release.open();
      const outcome = await linking;
      expect(outcome.kind).toBe('failed');
      expect(established).toHaveLength(1);
      expect(await sessions.get(established[0])).toBeNull();
      expect(await full.conn.model('FederatedIdentity').countDocuments({ providerId }).exec()).toBe(
        0,
      );
      expect(
        await full.conn
          .model('AuditLog')
          .countDocuments({ action: AuditAction.ACCOUNT_LINKED, actorId: u.sub })
          .exec(),
      ).toBe(0);
      expect(await redis.exists(trustKey(u.sub))).toBe(0);
    });
  });

  // ---------------------------------------------------------------- password policy (input axis)

  describe('common password: NFKC / case variants', () => {
    it.each<[string, string]>([
      ['upper case', 'PASSWORD1'],
      ['mixed case', 'PaSsWoRd1'],
      ['fullwidth (NFKC)', 'ｐａｓｓｗｏｒｄ１'],
      ['fullwidth upper (NFKC)', 'ＰＡＳＳＷＯＲＤ１'],
      [
        'mathematical bold digits (NFKC)',
        [...'123456789'].map((d) => String.fromCodePoint(0x1d7ce + Number(d))).join(''),
      ],
      ['product word inside, upper', 'MyVEYRIGATE#2026'],
      ['product word, fullwidth', 'ｓｓｏ－ｉｄｐ-2026!'],
    ])('register refuses %s with the fixed sentence (no echo)', async (_label, pw) => {
      const email = `r85t-${randomUUID()}@fixture.test`;
      const err = await full.app
        .get(AuthenticationService)
        .register(email, pw)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).message).toBe(COMMON_PASSWORD_MESSAGE);
      expect(await full.conn.model('User').countDocuments({ email }).exec()).toBe(0);
    });

    it('the change form refuses the email local part in upper case or fullwidth, hash unchanged', async () => {
      const u = await newUser(PASSWORD, `marlowe-${randomBytes(3).toString('hex')}`);
      const local = u.email.split('@')[0];
      const fullwidth = [...local]
        .map((ch) => (/[a-z0-9]/.test(ch) ? String.fromCodePoint(ch.codePointAt(0)! + 0xfee0) : ch))
        .join('');
      for (const candidate of [`${local.toUpperCase()}!x9`, `${fullwidth}!x9`]) {
        const s = await login(u.email, PASSWORD);
        const before = await hashOf(u.sub);
        const res = await change(s.jar, PASSWORD, candidate);
        expect(res.statusCode).toBe(400);
        expect(res.body).toContain(COMMON_PASSWORD_MESSAGE);
        expect(res.body).not.toContain(candidate);
        expect(await hashOf(u.sub)).toBe(before);
      }
    });
  });

  // ------------------------------------------------------------------ request_uri encodings

  describe('request / request_uri odd encodings', () => {
    const STATE = 'r85t-state';
    const authorize = async (rawExtra: string, sessionId?: string) => {
      const base = new URLSearchParams([
        ['response_type', 'code'],
        ['client_id', bff.clientId],
        ['redirect_uri', FLOW_REDIRECT],
        ['scope', 'openid api.read'],
        ['resource', FLOW_API_AUD],
        ['state', STATE],
        ['nonce', 'r85t-nonce'],
        ['code_challenge', deriveS256Challenge(randomBytes(32).toString('base64url'))],
        ['code_challenge_method', 'S256'],
      ]).toString();
      return full.app.inject({
        method: 'GET',
        url: `/authorize?${base}&${rawExtra}`,
        ...(sessionId ? { cookies: { [SESSION_COOKIE]: sessionId } } : {}),
      }) as Promise<Res>;
    };
    let sessionId = '';
    beforeAll(async () => {
      await settled(setup);
      const u = await newUser();
      await seedConsent(full.conn, {
        userId: u.sub,
        clientId: bff.clientId,
        resource: FLOW_API_AUD,
        scopes: ['openid', 'api.read'],
      });
      sessionId = (await full.app.get(SessionService).create(u.sub, DEFAULT_TENANT_ID)).id;
    }, INT_SETUP_TIMEOUT_MS);

    it.each<[string, string, string]>([
      [
        'percent-encoded key',
        'request_uri_not_supported',
        'request%5Furi=https%3A%2F%2Frp.example%2Fr',
      ],
      ['NUL value', 'request_uri_not_supported', 'request_uri=%00'],
      ['javascript: value', 'request_uri_not_supported', 'request_uri=javascript%3Aalert(1)'],
      [
        'urn value (PAR-style)',
        'request_uri_not_supported',
        'request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3Aabc',
      ],
      [
        '8 KB value',
        'request_uri_not_supported',
        `request_uri=https%3A%2F%2Frp.example%2F${'a'.repeat(8000)}`,
      ],
      ['broken percent escape', 'request_uri_not_supported', 'request_uri=%E0%A4%A'],
      ['bare key, no "="', 'request_uri_not_supported', 'request_uri'],
      ['percent-encoded "request" key', 'request_not_supported', 'r%65quest=e30'],
    ])('%s => 302 %s to the trusted redirect_uri, never a code', async (_label, error, extra) => {
      const res = await authorize(extra, sessionId);
      expect(res.statusCode).toBe(302);
      const loc = new URL(String(res.headers['location']));
      expect(`${loc.origin}${loc.pathname}`).toBe(FLOW_REDIRECT);
      expect(loc.searchParams.get('error')).toBe(error);
      expect(loc.searchParams.get('state')).toBe(STATE);
      expect(loc.searchParams.get('code')).toBeNull();
    });

    it('request with prompt=none and no session: request_not_supported wins over login_required', async () => {
      const res = await authorize('prompt=none&request=e30');
      expect(res.statusCode).toBe(302);
      expect(new URL(String(res.headers['location'])).searchParams.get('error')).toBe(
        'request_not_supported',
      );
    });

    it('parameter names are case-sensitive: REQUEST_URI is an unknown (ignored) parameter', async () => {
      const res = await authorize('REQUEST_URI=https%3A%2F%2Frp.example%2Fr', sessionId);
      expect(res.statusCode).toBe(302);
      expect(new URL(String(res.headers['location'])).searchParams.get('code')).toBeTruthy();
    });
  });

  // ------------------------------------------------------------------------ POST /userinfo

  describe('POST /userinfo: token outside the header, odd bodies', () => {
    let at = '';
    beforeAll(async () => {
      await settled(setup);
      const u = await newUser();
      await seedConsent(full.conn, {
        userId: u.sub,
        clientId: bff.clientId,
        resource: FLOW_API_AUD,
        scopes: ['openid', 'email', 'api.read'],
      });
      const sid = (await full.app.get(SessionService).create(u.sub, DEFAULT_TENANT_ID)).id;
      const verifier = randomBytes(32).toString('base64url');
      const code = await authorizeCode(full, {
        clientId: bff.clientId,
        sessionId: sid,
        resource: FLOW_API_AUD,
        scope: 'openid email api.read',
        verifier,
      });
      at = (
        await formPost(full, '/token', bff, {
          grant_type: 'authorization_code',
          code,
          redirect_uri: FLOW_REDIRECT,
          code_verifier: verifier,
          resource: FLOW_API_AUD,
        })
      ).json<{ access_token: string }>().access_token;
    }, INT_SETUP_TIMEOUT_MS);

    const post = (headers: Record<string, string>, payload?: string, query = '') =>
      full.app.inject({
        method: 'POST',
        url: `/userinfo${query}`,
        headers,
        payload,
      }) as Promise<Res>;
    const expect401 = (res: Res) => {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid_token' });
      expect(res.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
    };

    it('control: the minted access token works in the header', async () => {
      expect((await post({ authorization: `Bearer ${at}` })).statusCode).toBe(200);
    });

    it.each<[string, () => [Record<string, string>, string | undefined, string]]>([
      [
        'JSON body',
        () => [{ 'content-type': 'application/json' }, JSON.stringify({ access_token: at }), ''],
      ],
      ['query string', () => [{}, undefined, `?access_token=${at}`]],
      [
        'form body + query',
        () => [
          { 'content-type': 'application/x-www-form-urlencoded' },
          `access_token=${at}`,
          `?access_token=${at}`,
        ],
      ],
      ['text/plain body', () => [{ 'content-type': 'text/plain' }, at, '']],
      [
        'lower-case scheme in a body field "authorization"',
        () => [
          { 'content-type': 'application/json' },
          JSON.stringify({ authorization: `Bearer ${at}` }),
          '',
        ],
      ],
    ])('token only in the %s => 401 invalid_token, never 200', async (_label, make) => {
      const [headers, payload, query] = make();
      expect401(await post(headers, payload, query));
    });

    it.each<[string, string]>([
      ['application/json', JSON.stringify({ access_token: 'x'.repeat(2 * 1024 * 1024) })],
      ['application/x-www-form-urlencoded', `access_token=${'x'.repeat(2 * 1024 * 1024)}`],
    ])(
      'oversized %s body (2 MB) without a header => 401/413, never 5xx, no claims',
      async (type, payload) => {
        const res = await post({ 'content-type': type }, payload);
        expect([401, 413]).toContain(res.statusCode);
        expect(res.body).not.toContain('"sub"');
      },
    );

    it('oversized JSON body WITH a valid header => 413 or 200 (body ignored), never 5xx', async () => {
      const res = await post(
        { authorization: `Bearer ${at}`, 'content-type': 'application/json' },
        JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) }),
      );
      expect([200, 413]).toContain(res.statusCode);
    });

    it('malformed JSON body with a valid header => not 5xx', async () => {
      const res = await post(
        { authorization: `Bearer ${at}`, 'content-type': 'application/json' },
        '{"access_token":',
      );
      expect(res.statusCode).toBeLessThan(500);
    });
  });
});
