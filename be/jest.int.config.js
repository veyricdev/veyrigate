// `pnpm test:int` (DEBT-452/456): int options live here, not on the CLI, so a positional filter
// (`pnpm test:int authorize`) and `--testTimeout=N` reach jest as given instead of being merged
// into array flags (`--testRegex`, `--testTimeout`).
/** @type {import('jest').Config} */
module.exports = {
  ...require('./jest.config.js'),
  testRegex: '\\.int-spec\\.ts$',
  testTimeout: 20000,
  globalSetup: './test/int-preflight.mjs',
  globalTeardown: './test/int-teardown.mjs',
  // Run 92 (D92.3b): one worker at a time (still sequential: shared DBs + vg:int-lock), recycled when
  // its heap passes 1 GB. In band, every file's Nest/mongoose module graph stayed reachable: heap grew
  // ~30 MB per file to 3.8 GB (OOM on the 7 GB CI runner). `--runInBand` would disable both.
  maxWorkers: 1,
  workerIdleMemoryLimit: '1GB',
};
