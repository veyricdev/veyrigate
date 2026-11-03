// `pnpm test:sentinel` (DEBT-470): same as jest.int.config.js: options live here, not on the CLI, so a
// positional filter and `--testTimeout=N` reach jest as given. No globalTeardown: sentinel takes no int lock.
/** @type {import('jest').Config} */
module.exports = {
  ...require('./jest.config.js'),
  testRegex: '\\.sentinel-spec\\.ts$',
  testTimeout: 60000,
  globalSetup: './test/sentinel-preflight.mjs',
};
