import { jest } from '@jest/globals';
import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { OAuthExceptionFilter } from '../src/common/filters/oauth-exception.filter';
import { HealthController } from '../src/modules/health/health.controller';
import { MongoService } from '../src/database/mongo/mongo.service';
import { RedisService } from '../src/database/redis/redis.service';

/** A sibling route that throws so we can prove the global OAuth filter still formats other routes. */
@Controller()
class ProbeController {
  @Get('boom')
  boom(): never {
    throw new HttpException('nope', HttpStatus.INTERNAL_SERVER_ERROR);
  }
}

/**
 * DEBT-001 / DEBT-003: `/ready` returns its 503 + per-dependency body DIRECTLY (not via a thrown
 * exception), so the global `OAuthExceptionFilter` can NOT rewrite it to `{error:'server_error'}`.
 * The filter is registered globally here (as in production) and other routes still get the RFC 6749
 * `{error,error_description}` shape.
 */
describe('/ready readiness body survives the global OAuthExceptionFilter (DEBT-001/003)', () => {
  let app: NestFastifyApplication;
  const mongoPing = jest.fn<() => Promise<boolean>>();
  const redisPing = jest.fn<() => Promise<boolean>>();

  const get = (url: string) => app.inject({ method: 'GET', url });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController, ProbeController],
      providers: [
        { provide: MongoService, useValue: { ping: mongoPing } },
        { provide: RedisService, useValue: { ping: redisPing } },
        { provide: APP_FILTER, useClass: OAuthExceptionFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  afterEach(() => jest.clearAllMocks());

  it('both up => 200 {status:ok, mongo:up, redis:up} + no-store', async () => {
    mongoPing.mockResolvedValue(true);
    redisPing.mockResolvedValue(true);
    const res = await get('/ready');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ status: 'ok', mongo: 'up', redis: 'up' });
  });

  it('Mongo down (DEBT-003) => 503 with mongo:down, NOT server_error', async () => {
    mongoPing.mockRejectedValue(new Error('mongo refused'));
    redisPing.mockResolvedValue(true);
    const res = await get('/ready');
    expect(res.statusCode).toBe(503);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body).toEqual({ status: 'error', mongo: 'down', redis: 'up' });
    expect(body.error).toBeUndefined();
    expect(body.error_description).toBeUndefined();
    // Exposure budget: no host/message/stack leaked.
    expect(JSON.stringify(body)).not.toContain('mongo refused');
  });

  it('Redis down => 503 with redis:down, NOT server_error', async () => {
    mongoPing.mockResolvedValue(true);
    redisPing.mockRejectedValue(new Error('redis refused'));
    const res = await get('/ready');
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body).toEqual({ status: 'error', mongo: 'up', redis: 'down' });
    expect(body.error).toBeUndefined();
  });

  it('both down => 503 with both down', async () => {
    mongoPing.mockRejectedValue(new Error('x'));
    redisPing.mockRejectedValue(new Error('y'));
    const res = await get('/ready');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'error', mongo: 'down', redis: 'down' });
  });

  it('a sibling route that throws STILL gets the RFC 6749 {error,error_description} shape', async () => {
    const res = await get('/boom');
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error).toBe('server_error');
    expect(typeof body.error_description).toBe('string');
  });
});
