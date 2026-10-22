import { Redis } from "ioredis";

/**
 * Integration Redis for fe-admin tests: the shared test container `vg-test-redis` on :6479 (same
 * as be `test:int`). Tests only ever DEL the keys they created (tracked), never FLUSH.
 */
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6479/0";

export async function connectTestRedis(): Promise<Redis> {
  const redis = new Redis(TEST_REDIS_URL, {
    commandTimeout: 1000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: true,
    retryStrategy: () => null,
    lazyConnect: true,
  });
  try {
    await redis.connect();
    await redis.ping();
  } catch {
    redis.disconnect();
    throw new Error(
      `vg-test-redis is not reachable at ${TEST_REDIS_URL}. Start it with: docker start vg-test-redis`,
    );
  }
  return redis;
}
