import Redis from 'ioredis';

/**
 * Jest globalSetup for `test:sentinel` (run 53c). Opt-in but NEVER skips: without the throwaway
 * Sentinel (vg-b73c-*) the run fails with the command that starts it. Only the Sentinel port is
 * probed; the suite needs no vg-test-* container and no int lock.
 */
const START =
  '  bash be/scripts/sentinel-test-env.sh up\n' +
  '  pnpm -C be test:sentinel\n' +
  '  bash be/scripts/sentinel-test-env.sh down   # when done\n';

export default async function sentinelPreflight() {
  const sentinel = new Redis({
    host: '127.0.0.1',
    port: 26390,
    lazyConnect: true,
    connectTimeout: 2000,
    commandTimeout: 2000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  sentinel.on('error', () => undefined);
  let master = null;
  try {
    await sentinel.connect();
    master = await sentinel.call('SENTINEL', 'get-master-addr-by-name', 'idp');
  } catch {
    // reported below
  } finally {
    sentinel.disconnect();
  }
  if (!Array.isArray(master) || !String(master[0]).startsWith('vg-b73c-redis-')) {
    throw new Error(
      `test:sentinel needs the throwaway Sentinel on 127.0.0.1:26390 (master group "idp"). Start it:\n\n${START}`,
    );
  }
}
