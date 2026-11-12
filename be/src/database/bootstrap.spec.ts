import { parseBootstrapArgs, readBootstrapEnv } from './bootstrap';

/** Run 88 T1 (DEBT-164, D88.4/D88.5): argument allowlist + bootstrap-only env (AC4, AC7, AC10). */
const argv = (...args: string[]) => ['node', 'bootstrap.js', ...args];

describe('bootstrap parseBootstrapArgs', () => {
  it('parses --operator alone; switches default to false, no ticket', () => {
    expect(parseBootstrapArgs(argv('--operator', 'ops.alice'))).toEqual({
      operator: 'ops.alice',
      updateUris: false,
      rotateSecret: false,
      dryRun: false,
    });
  });

  it('accepts every switch with a ticket and pnpm `--`', () => {
    expect(
      parseBootstrapArgs(
        argv(
          '--',
          '--operator',
          'ops',
          '--ticket',
          'T-1',
          '--update-uris',
          '--rotate-secret',
          '--dry-run',
        ),
      ),
    ).toEqual({
      operator: 'ops',
      ticket: 'T-1',
      updateUris: true,
      rotateSecret: true,
      dryRun: true,
    });
  });

  it.each([
    ['missing --operator', [], /--operator/],
    ['operator outside its pattern', ['--operator', 'Ops Alice'], /--operator/],
    ['--update-uris without --ticket (AC4)', ['--operator', 'ops', '--update-uris'], /--ticket/],
    ['--rotate-secret without --ticket', ['--operator', 'ops', '--rotate-secret'], /--ticket/],
    ['ticket outside its pattern', ['--operator', 'ops', '--ticket', 'T 1;rm'], /--ticket/],
    ['unknown flag (AC10)', ['--operator', 'ops', '--yes'], /unknown argument/],
    ['--dry-run=true typo', ['--operator', 'ops', '--dry-run=true'], /unknown argument/],
    ['repeated flag', ['--operator', 'ops', '--operator', 'ops2'], /repeated/],
    ['flag without value', ['--operator'], /without value/],
  ])('%s => throws, value not echoed', (_n, args, re) => {
    let message = '';
    try {
      parseBootstrapArgs(argv(...(args as string[])));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(re as RegExp);
    for (const v of ['Ops Alice', 'T 1;rm', '--yes', '--dry-run=true', 'ops2']) {
      expect(message).not.toContain(v);
    }
  });
});

describe('bootstrap readBootstrapEnv (D88.4)', () => {
  const env = (
    redirect: string,
    logout = 'https://admin.example.com/',
    nodeEnv = 'production',
  ) => ({
    NODE_ENV: nodeEnv,
    BOOTSTRAP_FE_ADMIN_REDIRECT_URIS: redirect,
    BOOTSTRAP_FE_ADMIN_POST_LOGOUT_REDIRECT_URIS: logout,
  });

  it('https lists, trimmed, comma-separated', () => {
    expect(
      readBootstrapEnv(
        env(' https://admin.example.com/auth/callback , https://admin2.example.com/auth/callback'),
      ),
    ).toEqual({
      redirectUris: [
        'https://admin.example.com/auth/callback',
        'https://admin2.example.com/auth/callback',
      ],
      postLogoutRedirectUris: ['https://admin.example.com/'],
    });
  });

  it('http://localhost is accepted outside production only', () => {
    expect(
      readBootstrapEnv(
        env('http://localhost:3000/auth/callback', 'http://localhost:3000/', 'development'),
      ).redirectUris,
    ).toEqual(['http://localhost:3000/auth/callback']);
  });

  it.each([
    ['http://localhost in production (AC7)', env('http://localhost:3000/auth/callback')],
    ['wildcard (AC7)', env('https://*.example.com/cb')],
    ['fragment (AC7)', env('https://admin.example.com/cb#frag')],
    ['plain http', env('http://admin.example.com/cb')],
    ['relative', env('/auth/callback')],
    ['empty list', env('')],
    ['only commas', env(' , ,')],
    ['duplicate entry', env('https://a.example.com/cb,https://a.example.com/cb')],
    [
      'more than 10 entries',
      env(Array.from({ length: 11 }, (_, i) => `https://a${i}.example.com/cb`).join(',')),
    ],
    ['bad post-logout list', env('https://admin.example.com/cb', 'http://localhost:3000/')],
    [
      'missing variable',
      {
        NODE_ENV: 'production',
        BOOTSTRAP_FE_ADMIN_POST_LOGOUT_REDIRECT_URIS: 'https://a.example/',
      },
    ],
  ])('%s => throws naming the variable, no URI echoed', (_n, e) => {
    let message = '';
    try {
      readBootstrapEnv(e);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/BOOTSTRAP_FE_ADMIN_(POST_LOGOUT_)?REDIRECT_URIS/);
    expect(message).not.toMatch(/localhost:3000|example\.com|\/cb|#frag/);
  });
});
