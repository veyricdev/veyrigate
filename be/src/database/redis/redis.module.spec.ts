import type { AppConfig, DatabaseConfig } from '../../config/configuration';
import { buildRedisOptions, standaloneInProductionWarning } from './redis.module';

/** run 53c Task 1: one option builder for both modes; the fail-fast bounds are never mode-specific. */
const STANDALONE: DatabaseConfig = {
  mongoUri: 'unused',
  redisUrl: 'redis://r:6379',
  redisCommandTimeoutMs: 1000,
};
const SENTINEL: DatabaseConfig = {
  mongoUri: 'unused',
  redisSentinel: {
    sentinels: [
      { host: 's1', port: 26379 },
      { host: 's2', port: 26379 },
    ],
    masterName: 'idp',
    sentinelPassword: 'sp',
    username: 'u',
    password: 'p',
    db: 3,
  },
  redisCommandTimeoutMs: 1500,
};

describe('buildRedisOptions (run 53c)', () => {
  it('standalone: fail-fast bounds only (the URL carries host/credentials)', () => {
    const o = buildRedisOptions(STANDALONE);
    expect(o).toMatchObject({ maxRetriesPerRequest: 1, commandTimeout: 1000, lazyConnect: false });
    expect(o.retryStrategy?.(3)).toBe(600);
    expect(o.sentinels).toBeUndefined();
  });

  it('sentinel: same fail-fast bounds + sentinels/master/credentials/db', () => {
    const o = buildRedisOptions(SENTINEL);
    expect(o).toMatchObject({
      maxRetriesPerRequest: 1,
      commandTimeout: 1500,
      lazyConnect: false,
      sentinels: [
        { host: 's1', port: 26379 },
        { host: 's2', port: 26379 },
      ],
      name: 'idp',
      sentinelPassword: 'sp',
      username: 'u',
      password: 'p',
      db: 3,
    });
    expect(o.retryStrategy?.(20)).toBe(2000);
  });
});

describe('standaloneInProductionWarning (run 53c)', () => {
  const app = (nodeEnv: AppConfig['nodeEnv']) => ({ nodeEnv }) as AppConfig;
  it('production + REDIS_URL ⇒ a warning (boot continues)', () => {
    expect(standaloneInProductionWarning(app('production'), STANDALONE)).toMatch(/REDIS_SENTINELS/);
  });
  it('production + Sentinel, or non-production ⇒ none', () => {
    expect(standaloneInProductionWarning(app('production'), SENTINEL)).toBeUndefined();
    expect(standaloneInProductionWarning(app('development'), STANDALONE)).toBeUndefined();
  });
});
