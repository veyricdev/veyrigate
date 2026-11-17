import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * CodeQL #36 (run 92, D92.9): the drill/pentest lock lives in the checkout (not the shared tmpdir), is
 * created exclusively (a second holder is refused, a pre-existing file is never reused) and owner-only.
 * Runs the real `scripts/drills/lib.mjs` in a child node (the unit Jest does not resolve `.mjs`).
 */
describe('drills lib acquireLock', () => {
  it('exclusive, outside tmpdir, 0600 on POSIX, released on demand', () => {
    const be = process.cwd(); // jest runs from be/
    const script = `
      import { statSync, existsSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      const { LOCK_FILE, BE_DIR, acquireLock } = await import(process.argv[1]);
      const out = { inBe: LOCK_FILE.startsWith(BE_DIR), inTmp: LOCK_FILE.startsWith(tmpdir()) };
      const release = acquireLock('t1');
      try {
        out.mode = (statSync(LOCK_FILE).mode & 0o777).toString(8);
        try { acquireLock('t2'); out.second = 'acquired'; } catch (e) { out.second = String(e.message).includes('another drill holds') ? 'refused' : 'other'; }
      } finally { release(); }
      out.released = !existsSync(LOCK_FILE);
      console.log(JSON.stringify(out));
      process.exit(0);`;
    const out = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          script,
          pathToFileURL(join(be, 'scripts/drills/lib.mjs')).href,
        ],
        { cwd: be, encoding: 'utf8' },
      )
        .trim()
        .split('\n')
        .at(-1)!,
    );
    expect(out).toMatchObject({ inBe: true, inTmp: false, second: 'refused', released: true });
    if (process.platform !== 'win32') expect(out.mode).toBe('600');
  });
});
