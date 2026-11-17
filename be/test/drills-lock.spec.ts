import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * CodeQL #36 (run 92, D92.9) + DEBT-676 (run 93, D93.8): the drill/pentest lock lives in the OS user's home (one
 * per user on the host, every checkout; not the shared tmpdir), is created exclusively (a second holder is refused,
 * a pre-existing file is never reused) and owner-only. Runs the real `scripts/drills/lib.mjs` in a child node (the
 * unit Jest does not resolve `.mjs`) with HOME/USERPROFILE on a temp dir, so the real `~/.vg-drill.lock` is untouched.
 */
describe('drills lib acquireLock', () => {
  it('exclusive, in the home dir (not tmpdir, not be/), 0600 on POSIX, released on demand', () => {
    const be = process.cwd(); // jest runs from be/
    const home = mkdtempSync(join(tmpdir(), 'vg-lock-home-'));
    const script = `
      import { statSync, existsSync } from 'node:fs';
      import { dirname } from 'node:path';
      import { tmpdir } from 'node:os';
      const { LOCK_FILE, BE_DIR, acquireLock } = await import(process.argv[1]);
      const out = { dir: dirname(LOCK_FILE), inBe: LOCK_FILE.startsWith(BE_DIR), inTmpRoot: dirname(LOCK_FILE) === tmpdir() };
      const release = acquireLock('t1');
      try {
        out.mode = (statSync(LOCK_FILE).mode & 0o777).toString(8);
        try { acquireLock('t2'); out.second = 'acquired'; } catch (e) { out.second = String(e.message).includes('another drill holds') ? 'refused' : 'other'; }
      } finally { release(); }
      out.released = !existsSync(LOCK_FILE);
      console.log(JSON.stringify(out));
      process.exit(0);`;
    try {
      const out = JSON.parse(
        execFileSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            script,
            pathToFileURL(join(be, 'scripts/drills/lib.mjs')).href,
          ],
          {
            cwd: be,
            encoding: 'utf8',
            env: { ...process.env, HOME: home, USERPROFILE: home },
          },
        )
          .trim()
          .split('\n')
          .at(-1)!,
      );
      expect(out).toMatchObject({
        dir: home,
        inBe: false,
        inTmpRoot: false,
        second: 'refused',
        released: true,
      });
      if (process.platform !== 'win32') expect(out.mode).toBe('600');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
