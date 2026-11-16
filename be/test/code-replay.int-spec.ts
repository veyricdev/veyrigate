import { jest } from '@jest/globals';
import { randomBytes, randomUUID } from 'node:crypto';
import { hashPassword, sha256 } from '../src/common/crypto/crypto.util';
import { RedisService } from '../src/database/redis/redis.service';
import { ClientCredentialService } from '../src/modules/clients/client-credential.service';
import { ClientService } from '../src/modules/clients/client.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { UserService } from '../src/modules/identity/user.service';
import { UserTenantService } from '../src/modules/identity/user-tenant.service';
import { AuthorizationCodeService } from '../src/modules/oauth/code/authorization-code.service';
import { TokenService } from '../src/modules/oauth/token/token.service';
import { SessionService } from '../src/modules/sessions/session.service';
import {
  authorizeCode,
  bootFullApp,
  FLOW_API_AUD,
  FLOW_REDIRECT,
  formPost,
  seedFlowClient,
  type FullApp,
} from './full-app';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';
import { seedConsent } from './oauth-fixtures';

/**
 * Run 91 lot B (T4, DEBT-651, RFC 6749 §4.1.2, D91.6–D91.9): a replayed authorization code revokes
 * every token issued from it, but only when the replay comes from the code's own (authenticated)
 * client. Real app; Redis/Mongo of the int containers.
 */
type Auth = { clientId: string; secret: string };
const SCOPE = 'openid offline_access api.read';
const PASSWORD = 'run91 code replay password';

describe('run 91 lot B: authorization code replay revokes the tokens it issued (DEBT-651)', () => {
  let full: FullApp;
  let a: Auth;
  let b: Auth;
  let userId = '';

  let setup: Promise<void> | undefined;
  beforeAll(
    () =>
      (setup = (async () => {
        full = await bootFullApp({ name: 'run91b' });
        a = await seedFlowClient(full);
        // A second confidential client of the same tenant, same redirect (confused-deputy case).
        const clientId = `flow-b-${randomUUID()}`;
        await full.app.get(ClientService).create({
          clientId,
          clientType: 'confidential',
          tokenEndpointAuthMethod: 'client_secret_basic',
          redirectUris: [FLOW_REDIRECT],
          allowedResources: ['api'],
          scopes: ['openid', 'offline_access', 'api.read'],
          grantTypes: ['authorization_code', 'refresh_token'],
          tenantId: DEFAULT_TENANT_ID,
        });
        b = { clientId, ...(await full.app.get(ClientCredentialService).createSecret(clientId)) };
        const users = full.app.get(UserService);
        const user = await users.createWithPasswordHash(
          `run91b-${randomUUID()}@fixture.test`,
          await hashPassword(PASSWORD),
        );
        await users.verifyEmail(user.sub);
        await full.app.get(UserTenantService).addMembership(user.sub, DEFAULT_TENANT_ID);
        userId = user.sub;
        for (const clientId of [a.clientId, b.clientId]) {
          await seedConsent(full.conn, {
            userId,
            clientId,
            resource: FLOW_API_AUD,
            scopes: SCOPE.split(' '),
          });
        }
      })()),
    INT_SETUP_TIMEOUT_MS,
  );
  afterAll(async () => {
    await settled(setup);
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);
  afterEach(() => jest.restoreAllMocks());

  const session = async () =>
    (await full.app.get(SessionService).create(userId, DEFAULT_TENANT_ID)).id;
  const newCode = async (scope = SCOPE) => {
    const verifier = randomBytes(32).toString('base64url');
    const code = await authorizeCode(full, {
      clientId: a.clientId,
      sessionId: await session(),
      resource: FLOW_API_AUD,
      scope,
      verifier,
    });
    return { code, verifier };
  };
  const exchange = (
    c: { code: string; verifier: string },
    auth: Auth = a,
    redirect = FLOW_REDIRECT,
  ) =>
    formPost(full, '/token', auth, {
      grant_type: 'authorization_code',
      code: c.code,
      redirect_uri: redirect,
      code_verifier: c.verifier,
    });
  const active = async (at: string) =>
    (await formPost(full, '/introspect', a, { token: at })).json<{ active: boolean }>().active;
  const userinfo = async (at: string) =>
    (
      await full.app.inject({
        method: 'GET',
        url: '/userinfo',
        headers: { authorization: `Bearer ${at}` },
      })
    ).statusCode;
  const refresh = (rt: string) =>
    formPost(full, '/token', a, { grant_type: 'refresh_token', refresh_token: rt });
  const reuseAudits = () =>
    full.conn
      .model('AuditLog')
      .countDocuments({ action: 'TOKEN_REUSE_DETECTED', 'metadata.kind': 'authorization_code' });
  const usedKey = (code: string) => `authz_code_used:{${sha256(code)}}`;
  type Tokens = { access_token: string; refresh_token?: string; id_token?: string };

  it('same client replays: 400 invalid_grant; RT1 refresh 400, AT1 inactive, /userinfo 401, one reuse audit, no secret in audit', async () => {
    const c = await newCode();
    const first = await exchange(c);
    expect(first.statusCode).toBe(200);
    const t = first.json<Tokens>();
    expect(t.refresh_token).toBeDefined();
    const ttl = await full.app.get(RedisService).client.pttl(usedKey(c.code));
    expect(ttl).toBeGreaterThan(60_000); // max(60 s, ACCESS_TOKEN_TTL=900 s)
    const audits0 = await reuseAudits();

    const again = await exchange(c);
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ error: 'invalid_grant' });
    expect((await refresh(t.refresh_token!)).json()).toMatchObject({ error: 'invalid_grant' });
    expect(await active(t.access_token)).toBe(false);
    expect(await userinfo(t.access_token)).toBe(401);
    expect((await reuseAudits()) - audits0).toBe(1);
    const audit = JSON.stringify(await full.conn.model('AuditLog').find({}).lean());
    for (const secret of [c.code, t.access_token, t.refresh_token!]) {
      expect(audit).not.toContain(secret);
    }
  });

  it('another authenticated client replays the code: 400, but nothing of the original client is revoked', async () => {
    const c = await newCode();
    const t = (await exchange(c)).json<Tokens>();
    const audits0 = await reuseAudits();
    const xclient = await exchange(c, b);
    expect(xclient.statusCode).toBe(400);
    expect(xclient.json()).toMatchObject({ error: 'invalid_grant' });
    expect(await active(t.access_token)).toBe(true);
    expect((await refresh(t.refresh_token!)).statusCode).toBe(200);
    expect(await reuseAudits()).toBe(audits0);
  });

  it.each([
    [
      'a wrong code_verifier',
      (c: { code: string; verifier: string }) => ({
        ...c,
        verifier: randomBytes(32).toString('base64url'),
      }),
      FLOW_REDIRECT,
    ],
    [
      'a wrong redirect_uri',
      (c: { code: string; verifier: string }) => c,
      'https://app.example.com/other',
    ],
  ])('same client replays with %s: still revoked', async (_n, mutate, redirect) => {
    const c = await newCode();
    const t = (await exchange(c)).json<Tokens>();
    const again = await exchange(mutate(c), a, redirect);
    expect(again.statusCode).toBe(400);
    expect(await active(t.access_token)).toBe(false);
    expect((await refresh(t.refresh_token!)).statusCode).toBe(400);
  });

  it('a code without offline_access (no family): the replay still kills AT1', async () => {
    const c = await newCode('openid api.read');
    const t = (await exchange(c)).json<Tokens>();
    expect(t.refresh_token).toBeUndefined();
    expect((await exchange(c)).statusCode).toBe(400);
    expect(await active(t.access_token)).toBe(false);
  });

  it('race: a replay between consume and the family write => the first exchange returns no token and its family is revoked', async () => {
    const c = await newCode();
    const tokens = full.app.get(TokenService);
    const original = tokens.issueForAuthorizationCode.bind(tokens);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let entered = false;
    jest.spyOn(tokens, 'issueForAuthorizationCode').mockImplementationOnce(async (...args) => {
      entered = true;
      await gate;
      return original(...args);
    });
    const t0 = new Date();
    const lead = exchange(c);
    while (!entered) await new Promise((r) => setTimeout(r, 5));
    const replay = await exchange(c);
    expect(replay.statusCode).toBe(400);
    open();
    const res = await lead;
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_grant' });
    expect(res.body).not.toMatch(/access_token|refresh_token|id_token/);
    const fams = await full.conn
      .model('RefreshToken')
      .find({ userId, issuedAt: { $gte: t0 } })
      .lean();
    expect(fams.length).toBeGreaterThan(0);
    for (const f of fams) expect((f as { revokedAt?: Date }).revokedAt).toBeInstanceOf(Date);
  });

  it('Redis fails while recording the issued tokens => 500, no token, the new family is revoked', async () => {
    const c = await newCode();
    jest
      .spyOn(full.app.get(AuthorizationCodeService), 'markIssued')
      .mockRejectedValueOnce(new Error('redis down') as never);
    const t0 = new Date();
    const res = await exchange(c);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toMatch(/access_token|refresh_token|id_token/);
    const fams = await full.conn
      .model('RefreshToken')
      .find({ userId, issuedAt: { $gte: t0 } })
      .lean();
    expect(fams.length).toBe(1);
    expect((fams[0] as { revokedAt?: Date }).revokedAt).toBeInstanceOf(Date);
  });

  it('Redis fails while handling a same-client replay => 500 server_error (fail-closed)', async () => {
    const c = await newCode();
    (await exchange(c)).json<Tokens>();
    jest
      .spyOn(full.app.get(AuthorizationCodeService), 'markReplayed')
      .mockRejectedValueOnce(new Error('redis down') as never);
    const res = await exchange(c);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: 'server_error' });
  });

  it('unknown code, or a used-code mark that already expired => invalid_grant and nothing revoked', async () => {
    const unknown = await exchange({
      code: randomBytes(32).toString('base64url'),
      verifier: randomBytes(32).toString('base64url'),
    });
    expect(unknown.statusCode).toBe(400);
    const c = await newCode();
    const t = (await exchange(c)).json<Tokens>();
    await full.app.get(RedisService).client.del(usedKey(c.code));
    const audits0 = await reuseAudits();
    expect((await exchange(c)).statusCode).toBe(400);
    expect(await active(t.access_token)).toBe(true);
    expect((await refresh(t.refresh_token!)).statusCode).toBe(200);
    expect(await reuseAudits()).toBe(audits0);
  });
});
