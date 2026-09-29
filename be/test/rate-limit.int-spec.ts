import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import IORedis from 'ioredis';
import { OAuthExceptionFilter } from '../src/common/filters/oauth-exception.filter';
import { RedisService } from '../src/database/redis/redis.service';
import { RateLimit, RateLimitGuard } from '../src/modules/security/rate-limit/rate-limit.guard';
import { RateLimitService } from '../src/modules/security/rate-limit/rate-limit.service';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';
const RUN = `t${Date.now()}`;

@Controller()
class LoginController {
  @Post('login')
  @HttpCode(200)
  @RateLimit({ name: `${RUN}-login`, accountField: 'email', limit: 3, windowSec: 30 })
  login(@Body() _body: unknown) {
    return { ok: true };
  }
}

describe('Rate limit on real Redis (B1.8, spec §6.3)', () => {
  let redis: IORedis;
  let app: NestFastifyApplication;
  let service: RateLimitService;

  beforeAll(async () => {
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    const config = {
      getOrThrow: () => ({ rateLimitMax: 5, rateLimitWindow: 60 }),
    } as unknown as ConfigService;
    const moduleRef = await Test.createTestingModule({
      controllers: [LoginController],
      providers: [
        { provide: RedisService, useValue: new RedisService(redis) },
        {
          provide: RateLimitService,
          useFactory: (r: RedisService) => new RateLimitService(r, config),
          inject: [RedisService],
        },
        RateLimitGuard,
        { provide: APP_FILTER, useClass: OAuthExceptionFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    service = app.get(RateLimitService);
  });

  afterAll(async () => {
    const keys = await redis.keys(`rl:${RUN}-*`);
    if (keys.length) await redis.del(...keys);
    await app.close(); // RedisService.onApplicationShutdown quits the client
  });

  const login = (ip: string, email: string, device?: string) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/login',
        remoteAddress: ip,
        headers: device ? { 'x-device-id': device } : {},
        payload: { email },
      });

  it('rotating IPs does not bypass the per-account limit (case-insensitive email) → 429 + Retry-After', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 3; i++)
      codes.push((await login(`10.0.0.${i + 1}`, 'Victim@Example.com')).statusCode);
    const blocked = await login('10.0.0.99', '  victim@example.COM ');
    expect(codes).toEqual([200, 200, 200]);
    expect(blocked.statusCode).toBe(429);
    const retryAfter = Number(blocked.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(30);
    expect(blocked.json()).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'Too many requests',
    });
  });

  it('per-IP limit blocks one IP spraying many accounts', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 4; i++)
      codes.push((await login('10.1.1.1', `user${i}@example.com`)).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
  });

  it('per-device limit blocks one device across IPs and accounts', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 4; i++)
      codes.push((await login(`10.2.0.${i}`, `dev${i}@example.com`, 'dev-A')).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
  });

  it('keys hold no raw PII and always carry a TTL', async () => {
    const keys = await redis.keys(`rl:${RUN}-*`);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).toMatch(/^rl:[^:]+:(ip|account|deviceId):[0-9a-f]{64}$/);
      expect(key).not.toMatch(/example|10\.|dev-A/i);
      const ttl = await redis.pttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(30_000);
    }
  });

  it('uses RATE_LIMIT_MAX default and counts atomically under concurrency', async () => {
    const rule = { name: `${RUN}-burst` };
    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.hit(rule, { account: 'burst@example.com' })),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(results.filter((r) => !r.allowed).every((r) => r.exceeded.includes('account'))).toBe(
      true,
    );
  });
});
