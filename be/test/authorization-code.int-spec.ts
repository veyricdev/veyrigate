import IORedis from 'ioredis';
import { sha256 } from '../src/common/crypto/crypto.util';
import { RedisService } from '../src/database/redis/redis.service';
import {
  AuthorizationCodeService,
  type AuthorizationCodeData,
} from '../src/modules/oauth/code/authorization-code.service';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';
const RUN = `ac${Date.now()}`;

const dataFor = (userId: string): AuthorizationCodeData => ({
  clientId: `${RUN}-client`,
  redirectUri: 'https://app.example.com/callback',
  codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  resource: 'https://api.example.com/',
  scope: 'openid profile',
  nonce: 'rp-nonce',
  userId,
});

describe('AuthorizationCodeService on real Redis (B4.3, spec §9.1 step 3 / §9.5)', () => {
  let redis: IORedis;
  let svc: AuthorizationCodeService;

  beforeAll(() => {
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    svc = new AuthorizationCodeService(new RedisService(redis));
  });

  afterAll(async () => {
    const keys = await redis.keys(`authz_code:*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });

  it('stores only sha256(code): no raw code in any key, correct payload + TTL', async () => {
    const d = dataFor(`${RUN}-user-a`);
    const { code, data } = await svc.create(d);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url (CSPRNG, crypto.util B1.5)
    expect(data).toEqual(d);

    expect(await redis.exists(`authz_code:${code}`)).toBe(0);
    const raw = await redis.get(`authz_code:${sha256(code)}`);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain(code);
    expect(JSON.parse(raw!)).toEqual(d);

    const pttl = await redis.pttl(`authz_code:${sha256(code)}`);
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(60_000);

    const allKeys = await redis.keys('*');
    expect(allKeys.some((k) => k.includes(code))).toBe(false);

    await svc.consume(code, d.clientId, d.redirectUri);
  });

  it('C5(a): wrong clientId → null, code still intact (EXISTS=1), valid consume right after still succeeds', async () => {
    const d = dataFor(`${RUN}-user-b`);
    const { code } = await svc.create(d);

    expect(await svc.consume(code, 'wrong-client', d.redirectUri)).toBeNull();
    expect(await redis.exists(`authz_code:${sha256(code)}`)).toBe(1);

    const consumed = await svc.consume(code, d.clientId, d.redirectUri);
    expect(consumed).toEqual(d);
  });

  it('C5(a): wrong redirectUri → null, code still intact (EXISTS=1), valid consume right after still succeeds', async () => {
    const d = dataFor(`${RUN}-user-c`);
    const { code } = await svc.create(d);

    expect(await svc.consume(code, d.clientId, 'https://evil.example.com/cb')).toBeNull();
    expect(await redis.exists(`authz_code:${sha256(code)}`)).toBe(1);

    const consumed = await svc.consume(code, d.clientId, d.redirectUri);
    expect(consumed).toEqual(d);
  });

  it('C5(b): two concurrent consumes with the correct identity — exactly one succeeds', async () => {
    const d = dataFor(`${RUN}-user-d`);
    const { code } = await svc.create(d);

    const [a, b] = await Promise.all([
      svc.consume(code, d.clientId, d.redirectUri),
      svc.consume(code, d.clientId, d.redirectUri),
    ]);
    const wins = [a, b].filter((x) => x !== null);
    expect(wins).toHaveLength(1);
    expect(wins[0]).toEqual(d);
    expect(await redis.exists(`authz_code:${sha256(code)}`)).toBe(0);
  });

  it('C5(c): TTL is fixed at 60s (real PTTL on Redis, no sliding)', async () => {
    const d = dataFor(`${RUN}-user-e`);
    const { code } = await svc.create(d);
    const pttl = await redis.pttl(`authz_code:${sha256(code)}`);
    expect(pttl).toBeGreaterThan(59_000);
    expect(pttl).toBeLessThanOrEqual(60_000);
    await svc.consume(code, d.clientId, d.redirectUri);
  });

  it('C5(c): expired code (TTL elapsed) → consume returns null', async () => {
    const d = dataFor(`${RUN}-user-f`);
    const { code } = await svc.create(d);
    // Force-expire instead of sleeping 60s: real Redis TTL mechanics, not a mocked clock.
    await redis.pexpire(`authz_code:${sha256(code)}`, 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(await redis.exists(`authz_code:${sha256(code)}`)).toBe(0);
    expect(await svc.consume(code, d.clientId, d.redirectUri)).toBeNull();
  });

  it('C5(d): single-use — consuming an already-consumed code returns null', async () => {
    const d = dataFor(`${RUN}-user-g`);
    const { code } = await svc.create(d);
    expect(await svc.consume(code, d.clientId, d.redirectUri)).toEqual(d);
    expect(await svc.consume(code, d.clientId, d.redirectUri)).toBeNull();
  });

  it('unknown/empty code → null, no throw', async () => {
    expect(await svc.consume('does-not-exist', 'any-client', 'https://x/cb')).toBeNull();
    expect(await svc.consume('', 'any-client', 'https://x/cb')).toBeNull();
  });

  it('AC7: optional authTime round-trips through create → consume when supplied', async () => {
    const d: AuthorizationCodeData = { ...dataFor(`${RUN}-user-h`), authTime: 1_700_000_000 };
    const { code, data } = await svc.create(d);
    expect(data.authTime).toBe(1_700_000_000);
    const consumed = await svc.consume(code, d.clientId, d.redirectUri);
    expect(consumed).toEqual(d);
    expect(consumed?.authTime).toBe(1_700_000_000);
  });

  it('AC7: authTime is omitted (not fabricated) when caller does not supply it', async () => {
    const d = dataFor(`${RUN}-user-i`);
    const { code } = await svc.create(d);
    const consumed = await svc.consume(code, d.clientId, d.redirectUri);
    expect(consumed).not.toHaveProperty('authTime');
  });

  it('AC8: two codes minted by the service are CSPRNG-distinct (not sequential/predictable)', async () => {
    const { code: codeA } = await svc.create(dataFor(`${RUN}-user-j`));
    const { code: codeB } = await svc.create(dataFor(`${RUN}-user-k`));
    expect(codeA).not.toBe(codeB);
    expect(codeA).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codeB).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await svc.consume(codeA, `${RUN}-client`, 'https://app.example.com/callback');
    await svc.consume(codeB, `${RUN}-client`, 'https://app.example.com/callback');
  });

  it('AC3 (stronger): 5 concurrent consumes with the correct identity — exactly one succeeds', async () => {
    const d = dataFor(`${RUN}-user-l`);
    const { code } = await svc.create(d);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => svc.consume(code, d.clientId, d.redirectUri)),
    );
    const wins = results.filter((x) => x !== null);
    expect(wins).toHaveLength(1);
    expect(wins[0]).toEqual(d);
    expect(await redis.exists(`authz_code:${sha256(code)}`)).toBe(0);
  });
});
