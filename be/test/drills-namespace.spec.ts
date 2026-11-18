import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * DEBT-688 (run 94): `sameButExpired` decides `e2eUnchanged`/`devUnchanged` of the drills and the pentest. Only a
 * drop in a TTL collection (Mongo removing the owner's expired documents) may differ. Runs the real
 * `scripts/drills/lib.mjs` in a child node (the unit Jest does not resolve `.mjs`), as drills-lock.spec.ts does.
 */
describe('drills lib sameButExpired', () => {
  it('accepts only drops in TTL collections', () => {
    const before = { tokens: 5, users: 3 };
    const cases: [string, unknown, unknown, string[], boolean][] = [
      ['identical', before, { tokens: 5, users: 3 }, [], true],
      ['TTL collection dropped', before, { tokens: 2, users: 3 }, ['tokens'], true],
      ['TTL collection grew', before, { tokens: 6, users: 3 }, ['tokens'], false],
      ['non-TTL collection dropped', before, { tokens: 5, users: 2 }, ['tokens'], false],
      ['non-TTL collection grew', before, { tokens: 5, users: 4 }, ['tokens'], false],
      ['new collection', before, { tokens: 5, users: 3, x: 0 }, ['tokens'], false],
      ['TTL collection gone', before, { users: 3 }, ['tokens'], false],
      ['both absent (no db)', null, null, [], true],
      ['db appeared', null, before, [], false],
      ['db gone', before, null, [], false],
    ];
    const script = `
      const { sameButExpired } = await import(process.argv[1]);
      const cases = JSON.parse(process.argv[2]);
      console.log(JSON.stringify(cases.map(([, b, a, ttl]) => sameButExpired(b, a, ttl))));
      process.exit(0);`;
    const lib = pathToFileURL(join(process.cwd(), 'scripts/drills/lib.mjs')).href;
    const got = JSON.parse(
      execFileSync(
        process.execPath,
        ['--input-type=module', '-e', script, lib, JSON.stringify(cases)],
        { encoding: 'utf8' },
      ),
    ) as boolean[];
    expect(cases.map(([name], i) => `${name}: ${got[i]}`)).toEqual(
      cases.map(([name, , , , want]) => `${name}: ${want}`),
    );
  }, 30000);
});
