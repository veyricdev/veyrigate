import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

/** CodeQL #2 (D92.9): the front-channel continue script only navigates to http(s) URLs. */
describe('public/logout-redirect.js', () => {
  const src = readFileSync(join(process.cwd(), 'src/public/logout-redirect.js'), 'utf8');

  function run(target: string | null) {
    const replace = jest.fn();
    let timer: (() => void) | undefined;
    const link = target === null ? null : { getAttribute: () => target };
    vm.runInNewContext(src, {
      document: { getElementById: (id: string) => (id === 'logout-continue' ? link : null) },
      window: { location: { href: 'https://idp.example/logout', replace } },
      setTimeout: (fn: () => void) => (timer = fn),
      URL,
    });
    timer?.();
    return replace;
  }

  it.each([
    ['registered RP URI', 'https://rp.example/out?state=s', 'https://rp.example/out?state=s'],
    ['http dev RP URI', 'http://localhost:3000/out', 'http://localhost:3000/out'],
    ['default relative redirect', '/login?loggedOut=1', 'https://idp.example/login?loggedOut=1'],
  ])('%s => navigates', (_n, target, expected) => {
    const replace = run(target);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(expected);
  });

  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['javascript: mixed case + whitespace', ' JaVaScRiPt:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['vbscript:', 'vbscript:msgbox(1)'],
    ['unparseable', 'http://[::1'],
  ])('%s => never navigates', (_n, target) => {
    expect(run(target)).not.toHaveBeenCalled();
  });

  it('no link or empty target => no navigation, no throw', () => {
    expect(run(null)).not.toHaveBeenCalled();
    expect(run('')).not.toHaveBeenCalled();
  });
});
