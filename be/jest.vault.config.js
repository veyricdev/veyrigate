// `pnpm test:vault` (DEBT-470): same as jest.int.config.js: options live here, not on the CLI, so a
// positional filter and `--testTimeout=N` reach jest as given instead of merging into array flags.
/** @type {import('jest').Config} */
module.exports = {
  ...require('./jest.config.js'),
  testRegex: '\\.vault-spec\\.ts$',
  testTimeout: 60000,
  globalSetup: './test/vault-preflight.mjs',
  globalTeardown: './test/int-teardown.mjs',
};
