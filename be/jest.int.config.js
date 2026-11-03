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
};
