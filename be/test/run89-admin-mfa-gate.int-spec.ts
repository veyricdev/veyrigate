import { randomBytes, randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import { Types } from 'mongoose';
import { deriveS256Challenge } from '../src/common/crypto/pkce.util';
import { sha256 } from '../src/common/crypto/crypto.util';
import { RedisService } from '../src/database/redis/redis.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { UserService } from '../src/modules/identity/user.service';
import { MFA_KEYRING, type MfaKeyring } from '../src/modules/mfa/mfa-crypto';
import { MfaService } from '../src/modules/mfa/mfa.service';
import { totpAt, totpStep } from '../src/modules/mfa/totp';
import { AuthorizationCodeService } from '../src/modules/oauth/code/authorization-code.service';
import { TokenService } from '../src/modules/oauth/token/token.service';
import { SessionService } from '../src/modules/sessions/session.service';
import {
  bootFullApp,
  FLOW_ADMIN_AUD,
  FLOW_API_AUD,
  FLOW_REDIRECT,
  formPost,
  seedFlowClient,
  type FullApp,
  type InjectResponse,
} from './full-app';
import { enrollForTest } from './helpers/mfa';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';
import { seedConsent } from './oauth-fixtures';

/**
 * Run 89 T3 AC10–AC13, AC15, AC16 (D89.5/D89.6) on the REAL app with `ADMIN_MFA_REQUIRED=true`:
 * resource `admin` is issued only to a second factor not older than the current enrollment, at
 * `/authorize`, `/token` (code) and refresh. A second app with the gate off checks AC15.
 */
const PASSWORD = 'r89g-Current#Pass-1';
const SECRET = Buffer.from('r89-admin-gate-seed!', 'ascii');
const ADMIN_SCOPE = 'openid offline_access admin.read';
const API_SCOPE = 'openid offline_access api.read';

const setCookies = (res: InjectResponse): string[] =>
  ([] as string[]).concat((res.headers['set-cookie'] as string | string[] | undefined) ?? []);
const pairOf = (res: InjectResponse, name: string) =>
  setCookies(res)
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0];
const csrfOf = (res: InjectResponse): string => res.body.match(/name="_csrf" value="([^"]+)"/)![1];

type Ctx = { full: FullApp; bff: { clientId: string; secret: string } };

function harness(name: string, gate: boolean) {
  const ctx = {} as Ctx;
  let setup: Promise<void> | undefined;
  beforeAll(
    () =>
      (setup = (async () => {
        ctx.full = await bootFullApp({
          name,
          env: { ADMIN_MFA_REQUIRED: gate ? 'true' : 'false' },
        });
        ctx.bff = await seedFlowClient(ctx.full);
      })()),
    INT_SETUP_TIMEOUT_MS,
  );
  afterAll(async () => {
    await settled(setup);
    await ctx.full?.close();
  }, INT_SETUP_TIMEOUT_MS);
  return ctx;
}

/** Shared flows over one booted app. */
function flows(ctx: Ctx) {
  const newUser = async (enroll: boolean) => {
    const email = `r89g-${randomUUID()}@fixture.test`;
    const users = ctx.full.app.get(UserService);
    const u = await users.create({ email, password: PASSWORD });
    await users.verifyEmail(u.sub);
    await ctx.full.conn
      .model('UserTenant')
      .create({ userId: new Types.ObjectId(u.sub), tenantId: DEFAULT_TENANT_ID, status: 'active' });
    for (const [resource, scope] of [
      [FLOW_ADMIN_AUD, ADMIN_SCOPE],
      [FLOW_API_AUD, API_SCOPE],
    ]) {
      await seedConsent(ctx.full.conn, {
        userId: u.sub,
        clientId: ctx.bff.clientId,
        resource,
        scopes: scope.split(' '),
      });
    }
    const keyring = ctx.full.app.get<MfaKeyring>(MFA_KEYRING);
    const enrolled = enroll ? await enrollForTest(ctx.full.conn, keyring, u.sub, SECRET) : null;
    return { email, sub: u.sub, enrolledAt: enrolled?.enrolledAt };
  };
  /** Real sign-in through `/login` (+ `/login/mfa` when enrolled). Returns the session id. */
  const signIn = async (email: string, step = 0, returnTo = '/'): Promise<InjectResponse> => {
    const page = (await ctx.full.app.inject({ method: 'GET', url: '/login' })) as InjectResponse;
    const res = (await ctx.full.app.inject({
      method: 'POST',
      url: '/login',
      remoteAddress: `198.51.100.${Math.floor(Math.random() * 250)}`,
      headers: { cookie: pairOf(page, 'idp_csrf')! },
      payload: { _csrf: csrfOf(page), email, password: PASSWORD, returnTo },
    })) as InjectResponse;
    const ticket = pairOf(res, 'idp_mfa');
    if (!ticket) return res;
    const form = (await ctx.full.app.inject({
      method: 'GET',
      url: '/login/mfa',
      headers: { cookie: ticket },
    })) as InjectResponse;
    return ctx.full.app.inject({
      method: 'POST',
      url: '/login/mfa',
      headers: { cookie: ticket },
      payload: { _csrf: csrfOf(form), code: totpAt(SECRET, totpStep(Date.now()) + step) },
    }) as Promise<InjectResponse>;
  };
  const sessionIdOf = (res: InjectResponse) => pairOf(res, 'idp_session')!.split('=')[1];
  const authorize = (
    sessionId: string | undefined,
    resource: string,
    scope: string,
    verifier: string,
    extra: Record<string, string> = {},
    jar = '',
  ) =>
    ctx.full.app.inject({
      method: 'GET',
      url: `/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: ctx.bff.clientId,
        redirect_uri: FLOW_REDIRECT,
        scope,
        resource,
        state: 'rp-state',
        nonce: 'rp-nonce',
        code_challenge: deriveS256Challenge(verifier),
        code_challenge_method: 'S256',
        ...extra,
      }).toString()}`,
      headers: {
        cookie: [sessionId ? `idp_session=${sessionId}` : '', jar].filter(Boolean).join('; '),
      },
    }) as Promise<InjectResponse>;
  const codeOf = (res: InjectResponse) => {
    const loc = String(res.headers['location'] ?? '');
    return loc.startsWith(FLOW_REDIRECT) ? new URL(loc).searchParams.get('code') : null;
  };
  const exchange = (code: string, verifier: string, resource: string) =>
    formPost(ctx.full, '/token', ctx.bff, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: FLOW_REDIRECT,
      code_verifier: verifier,
      resource,
    });
  const refresh = (token: string) =>
    formPost(ctx.full, '/token', ctx.bff, { grant_type: 'refresh_token', refresh_token: token });
  const failures = (sub: string, action: string) =>
    ctx.full.conn
      .model('AuditLog')
      .find({ action, actorId: sub, result: 'failure' })
      .lean<Array<Record<string, unknown>>>()
      .exec();
  return { newUser, signIn, sessionIdOf, authorize, codeOf, exchange, refresh, failures };
}

describe('run 89 T3: admin MFA gate ON (real app)', () => {
  const ctx = harness('run89-gate-on', true);
  const f = flows(ctx);
  const verifier = () => randomBytes(32).toString('base64url');

  it('AC10/AC13/AC16 enrolled + session through step 2 => admin code, token, refresh twice (mfaAt carried); ID token amr = session amr, acr unchanged', async () => {
    const u = await f.newUser(true);
    const sid = f.sessionIdOf(await f.signIn(u.email));
    const v = verifier();
    const code = f.codeOf(await f.authorize(sid, FLOW_ADMIN_AUD, ADMIN_SCOPE, v));
    expect(code).toBeTruthy();
    const tok = await f.exchange(code!, v, FLOW_ADMIN_AUD);
    expect(tok.statusCode).toBe(200);
    const body = tok.json<{ id_token: string; refresh_token: string }>();
    expect(decodeJwt(body.id_token)).toMatchObject({
      amr: ['pwd', 'otp', 'mfa'],
      acr: 'urn:idp:aal1',
    });
    const fam = await ctx.full.conn
      .collection('refreshtokens')
      .findOne({ userId: new Types.ObjectId(u.sub), revokedAt: null });
    expect(typeof fam?.mfaAt).toBe('number');
    const r1 = await f.refresh(body.refresh_token);
    expect(r1.statusCode).toBe(200);
    const r2 = await f.refresh(r1.json<{ refresh_token: string }>().refresh_token);
    expect(r2.statusCode).toBe(200);
  });

  it('AC10 enrolled, session without mfa => 302 /login (reauthAfter); the old session cannot resume; step 2 then resumes to a code', async () => {
    const u = await f.newUser(true);
    const plain = await ctx.full.app
      .get(SessionService)
      .create(u.sub, DEFAULT_TENANT_ID, { amr: ['pwd'] });
    const v = verifier();
    const res = await f.authorize(plain.id, FLOW_ADMIN_AUD, ADMIN_SCOPE, v);
    expect(res.statusCode).toBe(302);
    const login = new URL(String(res.headers['location']), 'http://x');
    expect(login.pathname).toBe('/login');
    const returnTo = login.searchParams.get('returnTo')!;
    const jar = pairOf(res, 'idp_authz')!;
    const requestId = new URL(returnTo, 'http://x').searchParams.get('request_id')!;
    const ctxRaw = await ctx.full.app.get(RedisService).client.get(`authz_ctx:${requestId}`);
    expect(JSON.parse(ctxRaw!).reauthAfter).toEqual(expect.any(Number));

    // The old session cannot resume such a context (another request, same browser).
    const other = await f.authorize(plain.id, FLOW_ADMIN_AUD, ADMIN_SCOPE, v, {}, jar);
    const otherReturn = new URL(String(other.headers['location']), 'http://x').searchParams.get(
      'returnTo',
    )!;
    const stale = (await ctx.full.app.inject({
      method: 'GET',
      url: otherReturn,
      headers: { cookie: `idp_session=${plain.id}; ${jar}` },
    })) as InjectResponse;
    expect(new URL(String(stale.headers['location'])).searchParams.get('error')).toBe(
      'login_required',
    );

    // Second browser leg of the same user: sign in through step 2, then resume.
    const signed = await f.signIn(u.email, 0, returnTo);
    expect(signed.headers['location']).toBe(returnTo);
    const resumed = (await ctx.full.app.inject({
      method: 'GET',
      url: returnTo,
      headers: { cookie: `idp_session=${f.sessionIdOf(signed)}; ${jar}` },
    })) as InjectResponse;
    expect(f.codeOf(resumed)).toBeTruthy();
  });

  it('AC10 not enrolled => 403 mfa-required with the /account/mfa link back to /authorize, no code; prompt=none => login_required', async () => {
    const u = await f.newUser(false);
    const sid = f.sessionIdOf(await f.signIn(u.email));
    const res = await f.authorize(sid, FLOW_ADMIN_AUD, ADMIN_SCOPE, verifier());
    expect(res.statusCode).toBe(403);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatch(/href="\/account\/mfa\?returnTo=%2Fauthorize%3Frequest_id%3D[^"]+"/);
    expect(f.codeOf(res)).toBeNull();
    const none = await f.authorize(sid, FLOW_ADMIN_AUD, ADMIN_SCOPE, verifier(), {
      prompt: 'none',
    });
    expect(none.statusCode).toBe(302);
    const rp = new URL(String(none.headers['location']));
    expect(rp.origin + rp.pathname).toBe(FLOW_REDIRECT);
    expect(rp.searchParams.get('error')).toBe('login_required');
    expect(rp.searchParams.get('code')).toBeNull();
  });

  it('AC14 other resources are not gated: not enrolled + api => code', async () => {
    const u = await f.newUser(false);
    const sid = f.sessionIdOf(await f.signIn(u.email));
    const v = verifier();
    const code = f.codeOf(await f.authorize(sid, FLOW_API_AUD, API_SCOPE, v));
    expect(code).toBeTruthy();
    expect((await f.exchange(code!, v, FLOW_API_AUD)).statusCode).toBe(200);
  });

  it('AC11 session mfaAt older than the current enrollment (reset + re-enroll) => not satisfied => 302 /login', async () => {
    const u = await f.newUser(true);
    const sid = f.sessionIdOf(await f.signIn(u.email));
    await ctx.full.conn
      .collection('users')
      .updateOne(
        { _id: new Types.ObjectId(u.sub) },
        { $set: { 'mfa.enrolledAt': new Date(Date.now() + 60_000) } },
      );
    const res = await f.authorize(sid, FLOW_ADMIN_AUD, ADMIN_SCOPE, verifier());
    expect(res.statusCode).toBe(302);
    expect(String(res.headers['location'])).toMatch(/^\/login\?returnTo=/);
  });

  it.each<[string, (u: { sub: string; enrolledAt?: Date }) => Record<string, unknown>, boolean]>([
    ['code minted directly, no amr', () => ({}), true],
    ['amr mfa but no mfaAt', () => ({ amr: ['pwd', 'otp', 'mfa'] }), true],
    [
      'mfaAt older than enrolledAt',
      (u) => ({ amr: ['pwd', 'otp', 'mfa'], mfaAt: u.enrolledAt!.getTime() - 1 }),
      true,
    ],
    ['user no longer enrolled', () => ({ amr: ['pwd', 'otp', 'mfa'], mfaAt: Date.now() }), false],
  ])(
    'AC12 /token admin code: %s => invalid_grant mfa_required, code consumed',
    async (_n, extra, enroll) => {
      const u = await f.newUser(enroll);
      const live = await ctx.full.app
        .get(SessionService)
        .create(u.sub, DEFAULT_TENANT_ID, { amr: ['pwd'] });
      const v = verifier();
      const { code } = await ctx.full.app.get(AuthorizationCodeService).create({
        clientId: ctx.bff.clientId,
        redirectUri: FLOW_REDIRECT,
        codeChallenge: deriveS256Challenge(v),
        resource: FLOW_ADMIN_AUD,
        scope: ADMIN_SCOPE,
        userId: u.sub,
        authTime: Date.now(),
        sessionRef: live.session.ref,
        ...extra(u),
      });
      const res = await f.exchange(code, v, FLOW_ADMIN_AUD);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_grant' });
      expect((await f.failures(u.sub, 'TOKEN_ISSUED')).map((e) => e.reason)).toContain(
        'mfa_required',
      );
      expect(
        await ctx.full.conn
          .collection('refreshtokens')
          .countDocuments({ userId: new Types.ObjectId(u.sub), revokedAt: null }),
      ).toBe(0);
      expect((await f.exchange(code, v, FLOW_ADMIN_AUD)).statusCode).toBe(400);
    },
  );

  it('AC13 refresh: admin family without mfaAt (pre-run-89) => invalid_grant mfa_required; family re-enrolled after => refused too', async () => {
    const u = await f.newUser(true);
    const tokens = ctx.full.app.get(TokenService);
    const mint = (mfaAt?: number) =>
      tokens.insertRefreshToken({
        userId: u.sub,
        clientId: ctx.bff.clientId,
        scope: ADMIN_SCOPE.split(' '),
        resource: FLOW_ADMIN_AUD,
        familyId: randomUUID(),
        parentId: null,
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000),
        ...(mfaAt !== undefined ? { mfaAt } : {}),
      });
    const legacy = await mint();
    const r = await f.refresh(legacy.token);
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'invalid_grant' });
    expect((await f.failures(u.sub, 'TOKEN_REFRESHED')).map((e) => e.reason)).toContain(
      'mfa_required',
    );
    const ok = await mint(Date.now());
    const r1 = await f.refresh(ok.token);
    expect(r1.statusCode).toBe(200);
    await ctx.full.conn
      .collection('users')
      .updateOne(
        { _id: new Types.ObjectId(u.sub) },
        { $set: { 'mfa.enrolledAt': new Date(Date.now() + 60_000) } },
      );
    const r2 = await f.refresh(r1.json<{ refresh_token: string }>().refresh_token);
    expect(r2.statusCode).toBe(400);
  });

  it('api family without mfaAt is not gated', async () => {
    const u = await f.newUser(false);
    const t = await ctx.full.app.get(TokenService).insertRefreshToken({
      userId: u.sub,
      clientId: ctx.bff.clientId,
      scope: API_SCOPE.split(' '),
      resource: FLOW_API_AUD,
      familyId: randomUUID(),
      parentId: null,
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    expect((await f.refresh(t.token)).statusCode).toBe(200);
  });
});

describe('run 89 T3 AC15: admin MFA gate OFF (test only)', () => {
  const ctx = harness('run89-gate-off', false);
  const f = flows(ctx);

  it('not enrolled => admin code; enrolled => step 2 still runs and the session records amr + mfaAt', async () => {
    const plain = await f.newUser(false);
    const sid = f.sessionIdOf(await f.signIn(plain.email));
    const v = randomBytes(32).toString('base64url');
    const code = f.codeOf(await f.authorize(sid, FLOW_ADMIN_AUD, ADMIN_SCOPE, v));
    expect(code).toBeTruthy();
    expect((await f.exchange(code!, v, FLOW_ADMIN_AUD)).statusCode).toBe(200);

    const u = await f.newUser(true);
    const signed = await f.signIn(u.email);
    const raw = await ctx.full.app
      .get(RedisService)
      .client.get(`sess:${sha256(f.sessionIdOf(signed))}`);
    expect(JSON.parse(raw!)).toMatchObject({
      amr: ['pwd', 'otp', 'mfa'],
      mfaAt: expect.any(Number),
    });
    expect(await ctx.full.app.get(MfaService).state(u.sub)).toMatchObject({ enrolled: true });
  });
});
