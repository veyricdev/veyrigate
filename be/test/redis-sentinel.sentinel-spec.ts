import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import IORedis, { type RedisOptions } from 'ioredis';
import { isRedisUnavailable } from '../src/common/errors/dependency-unavailable';
import type { DatabaseConfig } from '../src/config/configuration';
import { buildRedisOptions } from '../src/database/redis/redis.module';

/**
 * Run 53c (B7.3, plan §6.2) against a REAL throwaway Sentinel (`be/scripts/sentinel-test-env.sh`):
 * the production client options (`buildRedisOptions`, Sentinel mode) survive a master failover.
 * Stop the master ⇒ while Sentinel switches, every command REJECTS fast (≤ commandTimeout + margin,
 * never hangs, never a stale success) with an error the 503 predicate recognises; a write succeeds on
 * the new master within 15 s. `natMap` (test only) maps the announced container hostnames to the
 * published 127.0.0.1 ports. Only keys `vg:b73c:*` are written; only vg-b73c-* containers are touched.
 */
const exec = promisify(execFile);
const COMMAND_TIMEOUT_MS = 1000;
const PORTS: Record<string, number> = { 'vg-b73c-redis-a': 16390, 'vg-b73c-redis-b': 16391 };
const db = (sentinelPort = 26390): DatabaseConfig => ({
  mongoUri: 'unused',
  redisSentinel: {
    sentinels: [{ host: '127.0.0.1', port: sentinelPort }],
    masterName: 'idp',
    db: 0,
  },
  redisCommandTimeoutMs: COMMAND_TIMEOUT_MS,
});
const natMap = Object.fromEntries(
  Object.entries(PORTS).map(([host, port]) => [`${host}:6379`, { host: '127.0.0.1', port }]),
);
const testOnly: RedisOptions = { natMap };
const docker = (...args: string[]) => exec('docker', args, { timeout: 30_000 });
const describeErr = (e: unknown) =>
  e instanceof Error ? `${e.constructor.name} | ${e.message.slice(0, 80)}` : String(e);

async function masterName(): Promise<string> {
  const s = new IORedis({ host: '127.0.0.1', port: 26390, maxRetriesPerRequest: 1 });
  try {
    const [host] = (await s.call('SENTINEL', 'get-master-addr-by-name', 'idp')) as string[];
    return host;
  } finally {
    s.disconnect();
  }
}

describe('Redis Sentinel failover with the production client options (run 53c)', () => {
  it('stop the master ⇒ fast rejections during the switch, a write lands on the new master ≤ 15 s', async () => {
    const client = new IORedis({ ...buildRedisOptions(db()), ...testOnly });
    client.on('error', () => undefined);
    const oldMaster = await masterName();
    expect(Object.keys(PORTS)).toContain(oldMaster); // never stop anything else
    const observed = new Set<string>();
    try {
      await client.set('vg:b73c:k', 'before');
      expect(await client.get('vg:b73c:k')).toBe('before');

      const stoppedAt = Date.now();
      await docker('stop', '-t', '1', oldMaster);
      let written = false;
      let attempts = 0;
      while (!written && Date.now() - stoppedAt < 15_000) {
        attempts++;
        const start = Date.now();
        try {
          await client.set('vg:b73c:k', `after-${attempts}`);
          written = true;
        } catch (err) {
          observed.add(describeErr(err));
          // Fast, and a shape the 503 path recognises (never a silent success, never a hang).
          expect(Date.now() - start).toBeLessThanOrEqual(COMMAND_TIMEOUT_MS + 700);
          expect(isRedisUnavailable(err)).toBe(true);
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      const elapsed = Date.now() - stoppedAt;
      console.log(
        `failover: ${attempts} attempts, write after ${elapsed} ms; errors: ${[...observed].join(' ; ') || '-'}`,
      );
      expect(written).toBe(true);
      expect(elapsed).toBeLessThanOrEqual(15_000);
      const newMaster = await masterName();
      expect(newMaster).not.toBe(oldMaster);
      expect(await client.get('vg:b73c:k')).toBe(`after-${attempts}`);
      expect(String(await client.call('ROLE'))).toMatch(/^master/);
    } finally {
      client.disconnect();
      await docker('start', oldMaster).catch(() => undefined); // rejoins as a replica
    }
  });

  it('no Sentinel reachable ⇒ commands reject fast with a recognised outage error (no hang)', async () => {
    const client = new IORedis({ ...buildRedisOptions(db(1)), ...testOnly });
    client.on('error', () => undefined);
    try {
      const start = Date.now();
      const err = await client.get('vg:b73c:k').then(
        () => null,
        (e: unknown) => e,
      );
      console.log(`no sentinel: ${describeErr(err)} after ${Date.now() - start} ms`);
      expect(err).toBeInstanceOf(Error);
      expect(Date.now() - start).toBeLessThanOrEqual(COMMAND_TIMEOUT_MS + 700);
      expect(isRedisUnavailable(err)).toBe(true);
    } finally {
      client.disconnect();
    }
  });
});
