import process from 'node:process';
import intPreflight from './int-preflight.mjs';

const { fetch, AbortSignal } = globalThis;

/**
 * Jest globalSetup for `test:vault` (run 53). The Vault suite is opt-in but NEVER skips: a missing
 * Vault fails the run with the command that starts the throwaway dev container. The root token is
 * only read from the environment (never printed, never written to a file). Then the regular
 * integration preflight runs (vg-test-mongo/redis for the full-app test V14 + the single-run lock;
 * released by int-teardown.mjs).
 */
const START =
  '  T=$(openssl rand -hex 16)\n' +
  '  docker run -d --name vg-b73-vault --cap-add=IPC_LOCK -e VAULT_DEV_ROOT_TOKEN_ID=$T \\\n' +
  '    -p 127.0.0.1:18200:8200 hashicorp/vault:2.1.2@sha256:c2f666266f383d2cf424d86b8bb8ce7d065562173ffec2b476d762943608bb55\n' +
  '  VAULT_TEST_ADDR=http://127.0.0.1:18200 VAULT_TEST_ROOT_TOKEN=$T pnpm -C be test:vault\n' +
  '  docker rm -f vg-b73-vault   # when done\n';

export default async function vaultPreflight() {
  const addr = process.env.VAULT_TEST_ADDR;
  if (!addr || !process.env.VAULT_TEST_ROOT_TOKEN) {
    throw new Error(
      `test:vault needs VAULT_TEST_ADDR and VAULT_TEST_ROOT_TOKEN. Start a dev Vault:\n\n${START}`,
    );
  }
  let status = 0;
  try {
    status = (await fetch(`${addr}/v1/sys/health`, { signal: AbortSignal.timeout(2000) })).status;
  } catch {
    // unreachable: reported below
  }
  if (status !== 200) {
    throw new Error(
      `Vault at VAULT_TEST_ADDR is not healthy (GET /v1/sys/health => ${status || 'unreachable'}). ` +
        `Start a dev Vault:\n\n${START}`,
    );
  }
  await intPreflight();
}
