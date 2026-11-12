import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Run 87 T5 (DEBT-590, D87.18): every container image the repo runs in CI, the dev compose, the prod
 * compose example and the test/smoke scripts is pinned by digest (`@sha256:<64 hex>`), so a re-tagged
 * upstream image cannot change what runs. Dependabot does not update workflow `services:` nor
 * `docker run` images (DEBT-611): refresh them by hand, keeping the tag comment.
 */
const REPO = join(process.cwd(), '..');
const WORKFLOWS = join(REPO, '.github', 'workflows');
const FILES = [
  ...readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith('.yml'))
    .map((f) => join('.github', 'workflows', f)),
  'docker-compose.yml',
  ...readdirSync(join(REPO, 'ops', 'compose'))
    .filter((f) => f.endsWith('.yml'))
    .map((f) => join('ops', 'compose', f)),
  join('be', 'scripts', 'docker-smoke.sh'),
  join('be', 'test', 'vault-preflight.mjs'),
];
/** The deployer substitutes the app image; it is a placeholder, not a pull. */
const PLACEHOLDER = '<registry>/veyrigate-be@sha256:<digest>';
const PINNED = /@sha256:[0-9a-f]{64}$/;
/** `name[:tag][@digest]` starting with a letter (ports like `27117:27017` start with a digit). */
const IMAGE_TOKEN =
  /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9._-]+)?(?:@sha256:[0-9a-f]+)?$/;

/** Image references of one file: YAML `image:`/anchors, `*_IMAGE=` variables, `docker run` args. */
export function imageRefs(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const refs: string[] = [];
  lines.forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    const yaml = /^\s*-?\s*image:\s*(\S+)/.exec(line) ?? /&[\w-]*image\s+(\S+)/.exec(line);
    if (yaml && !yaml[1].startsWith('*')) refs.push(yaml[1].replace(/^["']|["']$/g, ''));
    const variable = /\b[A-Z_]*IMAGE=(\S+)/.exec(line);
    if (variable && !variable[1].startsWith('"$') && !variable[1].startsWith('$')) {
      refs.push(variable[1]);
    }
    if (!/docker run\b/.test(line)) return;
    // The command and its next two (continuation / folded) lines.
    const tokens = lines
      .slice(i, i + 3)
      .join(' ')
      .split(/\s+/)
      .map((t) => t.replace(/^["'\\]+|["'\\]+$/g, ''))
      .filter((t) => t.includes(':') || t.includes('@'));
    for (const t of tokens) if (IMAGE_TOKEN.test(t)) refs.push(t);
  });
  return [...new Set(refs)];
}

describe('container images are pinned by digest (DEBT-590)', () => {
  it.each(FILES)('%s: every image reference has @sha256:<64 hex>', (file) => {
    const refs = imageRefs(readFileSync(join(REPO, file), 'utf8'));
    const unpinned = refs.filter((r) => r !== PLACEHOLDER && !PINNED.test(r));
    expect(unpinned).toEqual([]);
  });

  it('finds the images it must guard (not vacuous)', () => {
    const all = FILES.flatMap((f) => imageRefs(readFileSync(join(REPO, f), 'utf8')));
    for (const name of [
      'mongo:',
      'redis:',
      'axllent/mailpit:',
      'hashicorp/vault:',
      'prom/prometheus:',
    ]) {
      expect(all.some((r) => r.startsWith(name))).toBe(true);
    }
  });

  it.each([
    ['image: mongo:7', ['mongo:7']],
    ['    image: redis:7.4@sha256:' + 'a'.repeat(64), ['redis:7.4@sha256:' + 'a'.repeat(64)]],
    ['docker run -d --name x -p 27117:27017 mongo:7 --replSet rs0', ['mongo:7']],
    [
      'docker run -d --name x \\\n  -p 127.0.0.1:1:2 \\\n  hashicorp/vault:2.1.2',
      ['hashicorp/vault:2.1.2'],
    ],
    ['docker run --rm --user 0:0 --entrypoint sh "$IMAGE" -c "x"', []],
    ['MONGO_IMAGE=mongo:7.0.43', ['mongo:7.0.43']],
    ['x-redis-image: &redis-image redis:7', ['redis:7']],
    ['    image: *redis-image', []],
    ['# docker run --rm mongo:7', []],
  ])('parser: %j => %j', (text, want) => {
    expect(imageRefs(text)).toEqual(want);
  });
});
