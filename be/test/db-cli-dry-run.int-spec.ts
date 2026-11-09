import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { join } from 'node:path';

/**
 * DEBT-254 / DEBT-256: the BUILT DB CLIs (`pnpm -C be build`). The target is a closed local port
 * (`127.0.0.1:1`) or a local counting listener, never a real DB: `--dry-run` must exit 0 without
 * connecting; without the flag the connection fails and stderr must not echo the credential of
 * `MONGO_URI`.
 */
const DIST = join(process.cwd(), 'dist', 'database');
const CLIS = {
  'sync-indexes': join(DIST, 'mongo', 'sync-indexes.js'),
  seed: join(DIST, 'seed.js'),
  'seed-dev': join(DIST, 'seed-dev.js'),
} as const;
const SECRET = 'cli-s3cret';
const URI = `mongodb://u:${SECRET}@127.0.0.1:1/x`;

const env = (mongoUri = URI) => ({
  PATH: process.env.PATH ?? '',
  SystemRoot: process.env.SystemRoot ?? '',
  NODE_ENV: 'test',
  ISSUER: 'http://localhost:4000',
  MONGO_URI: mongoUri,
  REDIS_URL: 'redis://127.0.0.1:1',
  ACCESS_TOKEN_TTL: '900',
  REFRESH_TOKEN_TTL: '2592000',
  SESSION_IDLE_TTL: '3600',
  SESSION_ABSOLUTE_TTL: '86400',
  SESSION_COOKIE_SECURE: 'false',
  KEY_PROVIDER: 'local',
  KEY_LOCAL_DIR: join(process.cwd(), 'test'),
  SMTP_URL: 'smtp://127.0.0.1:9',
  ADMIN_SEED_EMAIL: 'admin@fixture.test',
  ADMIN_SEED_PASSWORD: 'cli-dry-run-admin-pw',
  DEV_SEED_EMAIL: 'dev@fixture.test',
  DEV_SEED_PASSWORD: 'cli-dry-run-dev-pw',
  CSRF_SECRET: 'cli-dry-run-csrf-not-a-real-secret',
  RATE_LIMIT_WINDOW: '60',
  RATE_LIMIT_MAX: '100000',
  CLIENT_AUTH_FAIL_IP_MAX: '100000',
  CLIENT_AUTH_FAIL_CLIENT_MAX: '100000',
});

const run = (cli: string, args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], {
    env: env(),
    encoding: 'utf8',
    timeout: 30_000,
  });

/**
 * Run 78 tester: "no connection" is proven by a local TCP listener that COUNTS accepted sockets
 * (it resets each one), not by wall clock. The former `< 3000 ms` bound flaked: a cold
 * `node dist/database/seed.js` alone takes ~2.3 s on Windows and 4.6-6.3 s under parallel load
 * (reproduced), while the property under test is "0 sockets opened". The child runs async (spawn)
 * so this process's event loop accepts the sockets while the child runs.
 */
let counter: Server;
let accepted = 0;
let counterUri = '';

const runCounted = (cli: string, args: string[]) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env: env(counterUri) });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });

describe('DB CLIs --dry-run + error text (DEBT-254, DEBT-256)', () => {
  beforeAll(async () => {
    for (const cli of Object.values(CLIS)) {
      // Never skip silently: a missing build is a failure with the fix in the message.
      if (!existsSync(cli)) throw new Error(`${cli} missing: run pnpm -C be build`);
    }
    counter = createServer((socket) => {
      accepted += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => counter.listen(0, '127.0.0.1', resolve));
    const port = (counter.address() as AddressInfo).port;
    counterUri = `mongodb://u:${SECRET}@127.0.0.1:${port}/x`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => counter.close(() => resolve()));
  });

  beforeEach(() => {
    accepted = 0;
  });

  const target = () => `target: ${counterUri.slice(counterUri.indexOf('@') + 1)}`;

  // Positive control: the counter does see a CLI that connects (else "0 accepted" proves nothing).
  it('control: sync-indexes WITHOUT the flag on the counting listener ⇒ ≥ 1 socket, exit 1, no credential', async () => {
    const r = await runCounted(CLIS['sync-indexes'], []);
    expect(r.status).toBe(1);
    expect(accepted).toBeGreaterThan(0);
    expect(r.stdout).toBe(`${target()}\n`);
    expect(r.stdout + r.stderr).not.toContain(SECRET);
  }, 30_000);

  it.each(Object.keys(CLIS) as (keyof typeof CLIS)[])(
    '%s --dry-run ⇒ exit 0, prints only the target + the dry-run line, 0 sockets opened',
    async (name) => {
      const r = await runCounted(CLIS[name], ['--dry-run']);
      expect([r.status, r.stderr]).toEqual([0, '']);
      expect(accepted).toBe(0);
      expect(r.stdout).toBe(`${target()}\ndry-run: no connection made\n`);
      expect(r.stdout).not.toContain(SECRET);
    },
    30_000,
  );

  it.each(Object.keys(CLIS) as (keyof typeof CLIS)[])(
    '%s -- --dry-run (pnpm separator) ⇒ same dry run, exit 0, 0 sockets opened',
    async (name) => {
      const r = await runCounted(CLIS[name], ['--', '--dry-run']);
      expect([r.status, r.stderr]).toEqual([0, '']);
      expect(accepted).toBe(0);
      expect(r.stdout).toBe(`${target()}\ndry-run: no connection made\n`);
    },
    30_000,
  );

  // DEBT-522: a typo of the safety flag must never fall through to a real (writing) run.
  it.each(
    (Object.keys(CLIS) as (keyof typeof CLIS)[]).flatMap((name) =>
      ['--dry-run=true', '--dryrun', '-n'].map((arg) => [name, arg] as const),
    ),
  )(
    '%s %s ⇒ exit 1 with a fixed message, before any env read or connection',
    async (name, arg) => {
      const r = await runCounted(CLIS[name], ['--', arg]);
      expect(r.status).toBe(1);
      expect(accepted).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(
        /^(Index sync|seed|seed-dev) failed: unknown argument \(allowed: --dry-run\)\n$/,
      );
      expect(r.stderr).not.toContain(arg);
    },
    30_000,
  );

  it.each(Object.keys(CLIS) as (keyof typeof CLIS)[])(
    '%s without the flag ⇒ prints the target, connects, fails exit 1, no credential in output',
    (name) => {
      const r = run(CLIS[name], []);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('target: 127.0.0.1:1/x');
      expect(r.stdout).not.toContain('dry-run');
      expect(r.stderr).toMatch(/failed: /);
      expect(r.stdout + r.stderr).not.toContain(SECRET);
    },
    30_000,
  );
});
