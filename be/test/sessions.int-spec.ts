import type { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import { sha256 } from '../src/common/crypto/crypto.util';
import { RedisService } from '../src/database/redis/redis.service';
import { SessionService } from '../src/modules/sessions/session.service';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';
const RUN = `t${Date.now()}`;

const config = (idle: number, absolute: number) =>
  ({
    getOrThrow: () => ({ sessionIdleTtl: idle, sessionAbsoluteTtl: absolute }),
  }) as unknown as ConfigService;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('SessionService on real Redis (B2.3, INV-16/17)', () => {
  let redis: IORedis;
  let clock: number;
  let onNow: (() => Promise<void> | void) | undefined;
  let svc: SessionService; // idle 8h / absolute 30d, injected clock
  let short: SessionService; // idle 1s / absolute 60s, real clock
  const user = (n: string) => `${RUN}-${n}`;

  beforeAll(() => {
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    const rs = new RedisService(redis);
    clock = Date.now();
    svc = new SessionService(rs, config(28800, 2592000), () => {
      void onNow?.();
      return clock;
    });
    short = new SessionService(rs, config(1, 60));
  });

  afterEach(() => {
    onNow = undefined;
  });

  afterAll(async () => {
    const keys = await redis.keys(`user_sess:${RUN}-*`);
    for (const k of keys) await svc.revokeAllForUser(k.slice('user_sess:'.length));
    await redis.quit();
  });

  it('stores only sha256(id): no raw ID in any key or value; data shape + TTL', async () => {
    const { id, session } = await svc.create(user('a'), 'tenant-A', { deviceLabel: 'Firefox' });
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
    expect(session.ref).toBe(sha256(id));
    expect(await redis.exists(`sess:${id}`)).toBe(0);
    const raw = await redis.get(`sess:${sha256(id)}`);
    expect(raw).not.toContain(id);
    expect(JSON.parse(raw!)).toEqual({
      userId: user('a'),
      tenantId: 'tenant-A',
      authTime: clock,
      createdAt: clock,
      lastSeenAt: clock,
      device: { label: 'Firefox' },
    });
    const pttl = await redis.pttl(`sess:${sha256(id)}`);
    expect(pttl).toBeGreaterThan(28_790_000);
    expect(pttl).toBeLessThanOrEqual(28_800_000);
    expect(await redis.sismember(`user_sess:${user('a')}`, sha256(id))).toBe(1);
    expect(await redis.pttl(`user_sess:${user('a')}`)).toBeGreaterThan(2_591_000_000);
    const allKeys = await redis.keys('*');
    expect(allKeys.some((k) => k.includes(id))).toBe(false);
  });

  it('fixation: establish() always issues a new ID and kills the pre-login (anonymous) one', async () => {
    // Pre-login (anonymous) session planted by an attacker-chosen / earlier ID.
    const anonId = `${RUN}-anon`;
    await redis.set(`sess:${sha256(anonId)}`, JSON.stringify({ createdAt: clock }), 'EX', 60);
    const { id: fresh } = await svc.establish(anonId, user('fix'), 'tenant-A');
    expect(fresh).not.toBe(anonId);
    expect(await redis.exists(`sess:${sha256(anonId)}`)).toBe(0);
    expect(await svc.get(anonId)).toBeNull();
    expect((await svc.get(fresh))?.userId).toBe(user('fix'));

    // Re-login on an authenticated session also rotates.
    const { id: again } = await svc.establish(fresh, user('fix'), 'tenant-A');
    expect(again).not.toBe(fresh);
    expect(await svc.get(fresh)).toBeNull();
    expect(await redis.sismember(`user_sess:${user('fix')}`, sha256(fresh))).toBe(0);

    // Unknown / forged old ID does not block establishing a new session.
    const { id: third } = await svc.establish('forged-id', user('fix'), 'tenant-A');
    expect(await svc.get(third)).not.toBeNull();
  });

  it('INV-16: IDs are opaque and random — unique per session, no userId/tenant/device inside', async () => {
    const uid = user('opaque');
    const ids = await Promise.all(
      Array.from({ length: 20 }, () => svc.create(uid, 'tenant-A', { deviceLabel: 'dev@x.com' })),
    );
    const values = ids.map((s) => s.id);
    expect(new Set(values).size).toBe(values.length);
    for (const id of values) {
      expect(id).not.toContain(uid);
      expect(id).not.toContain('tenant-A');
      expect(id).not.toContain('dev@x.com');
      expect(Buffer.from(id, 'base64url').toString('latin1')).not.toContain(uid);
    }
  });

  it('get() of unknown/empty ID → null', async () => {
    expect(await svc.get('does-not-exist')).toBeNull();
    expect(await svc.get('')).toBeNull();
  });

  it('idle: sliding while active, gone after idle TTL without activity', async () => {
    const { id } = await short.create(user('idle'), 'tenant-A');
    await sleep(600);
    expect(await short.get(id)).not.toBeNull(); // slides to a fresh 1s
    await sleep(600);
    expect(await short.get(id)).not.toBeNull(); // 1.2s after create, still alive thanks to sliding
    await sleep(1300);
    expect(await short.get(id)).toBeNull();
  }, 10_000);

  it('absolute: expires even when continuously active; TTL never extends past the deadline', async () => {
    const start = clock;
    const { id, session } = await svc.create(user('abs'), 'tenant-A');
    clock = start + 2592000_000 - 5_000; // 5s before absolute deadline, active use
    const s = await svc.get(id);
    expect(s?.lastSeenAt).toBe(clock);
    const pttl = await redis.pttl(`sess:${session.ref}`);
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(5_000); // min(idle, deadline - now)

    clock = start + 2592000_000; // deadline reached (key may still exist — explicit check kills it)
    await redis.pexpire(`sess:${session.ref}`, 60_000);
    expect(await svc.get(id)).toBeNull();
    expect(await redis.exists(`sess:${session.ref}`)).toBe(0);
    expect(await redis.sismember(`user_sess:${user('abs')}`, session.ref)).toBe(0);
    clock = start;
  });

  it('C4: a revoke racing a get() is never undone (SET XX)', async () => {
    const { id } = await svc.create(user('race'), 'tenant-A');
    // `now()` runs after get() has read the session and before it writes back.
    onNow = () => void redis.del(`sess:${sha256(id)}`);
    const res = await svc.get(id);
    onNow = undefined;
    expect(res).toBeNull();
    expect(await redis.exists(`sess:${sha256(id)}`)).toBe(0);
  });

  it('revokeByDevice revokes exactly that session; other user cannot revoke it (IDOR)', async () => {
    const a1 = await svc.create(user('devA'), 'tenant-A', { deviceLabel: 'laptop' });
    const a2 = await svc.create(user('devA'), 'tenant-A', { deviceLabel: 'phone' });
    const b1 = await svc.create(user('devB'), 'tenant-A');

    expect(await svc.revokeByDevice(user('devA'), b1.session.ref)).toBe(false);
    expect(await svc.get(b1.id)).not.toBeNull();

    // Even if B's ref were planted in A's index, stored userId must match.
    await redis.sadd(`user_sess:${user('devA')}`, b1.session.ref);
    expect(await svc.revokeByDevice(user('devA'), b1.session.ref)).toBe(false);
    expect(await svc.get(b1.id)).not.toBeNull();
    await redis.srem(`user_sess:${user('devA')}`, b1.session.ref);

    expect(await svc.revokeByDevice(user('devA'), a1.session.ref)).toBe(true);
    expect(await svc.get(a1.id)).toBeNull();
    expect(await svc.get(a2.id)).not.toBeNull();
    const list = await svc.listByUser(user('devA'));
    expect(list.map((s) => s.device.label)).toEqual(['phone']);
    expect(list[0].ref).toBe(a2.session.ref);
  });

  it('listByUser prunes index entries whose session expired', async () => {
    const s1 = await svc.create(user('list'), 'tenant-A');
    const s2 = await svc.create(user('list'), 'tenant-A');
    await redis.del(`sess:${s1.session.ref}`); // simulate TTL expiry
    const list = await svc.listByUser(user('list'));
    expect(list.map((s) => s.ref)).toEqual([s2.session.ref]);
    expect(await redis.smembers(`user_sess:${user('list')}`)).toEqual([s2.session.ref]);
  });

  it('revoke(id) and revokeAllForUser remove sessions and the index', async () => {
    const s1 = await svc.create(user('all'), 'tenant-A');
    const s2 = await svc.create(user('all'), 'tenant-B');
    const other = await svc.create(user('keep'), 'tenant-A');
    await svc.revoke(s1.id);
    expect(await svc.get(s1.id)).toBeNull();
    expect(await svc.revokeAllForUser(user('all'))).toBe(1);
    expect(await svc.get(s2.id)).toBeNull();
    expect(await redis.exists(`user_sess:${user('all')}`)).toBe(0);
    expect(await svc.get(other.id)).not.toBeNull();
  });

  it('Redis errors propagate instead of reading as "no session" (C9)', async () => {
    const dead = new IORedis('redis://127.0.0.1:1', {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    dead.on('error', () => undefined);
    const broken = new SessionService(new RedisService(dead), config(60, 600));
    await expect(broken.get('some-id')).rejects.toThrow();
    await expect(broken.create(user('x'), 'tenant-A')).rejects.toThrow();
    dead.disconnect();
  });
});
