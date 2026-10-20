import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootFullApp, type FullApp } from './full-app';

/**
 * `@fastify/static` 8 -> 10 regression (run 38, B7.4 Task 1): the real `configureApp` mount of
 * `src/public` under `/assets/` must still serve the stylesheet, and never serve anything outside
 * `public/`, dotfiles or a directory listing.
 */
describe('static assets under /assets/ (B7.4)', () => {
  let full: FullApp;
  const publicDir = join(process.cwd(), 'src', 'public');
  // A real dotfile inside public/ for the run, so "404" proves the dotfile rule, not a missing file.
  const dotName = `.vg-dot-${process.pid}-${Date.now()}`;
  const DOT_BODY = 'vg-dotfile-must-not-be-served';
  // Content of a file just outside public/ (src/app.module.ts) that traversal would expose.
  let outsideMarker = '';

  beforeAll(async () => {
    await writeFile(join(publicDir, dotName), DOT_BODY);
    outsideMarker = (await readFile(join(publicDir, '..', 'app.module.ts'), 'utf8')).slice(0, 40);
    full = await bootFullApp({ name: 'static' });
  }, 60_000);

  afterAll(async () => {
    await rm(join(publicDir, dotName), { force: true });
    if (full) await full.close();
  });

  const get = (url: string) => full.app.inject({ method: 'GET', url });

  it('serves the stylesheet as text/css', async () => {
    const res = await get('/assets/styles.css');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/css/);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it.each([
    '/assets/../app.module.ts',
    '/assets/%2e%2e/app.module.ts',
    '/assets/..%2fapp.module.ts',
    '/assets/%2e%2e%2fapp.module.ts',
    '/assets/..%5capp.module.ts',
    '/assets/../../package.json',
    '/assets/%2e%2e/%2e%2e/package.json',
  ])('traversal %s is not served', async (url) => {
    const res = await get(url);
    expect(res.statusCode).not.toBe(200);
    expect(res.body).not.toContain(outsideMarker);
    expect(res.body).not.toContain('"@sso-idp/be"');
  });

  it.each([`/assets/${dotName}`, `/assets/%2e${dotName.slice(1)}`])(
    'dotfile %s => 403/404',
    async (url) => {
      const res = await get(url);
      expect([403, 404]).toContain(res.statusCode);
      expect(res.body).not.toContain(DOT_BODY);
    },
  );

  it.each(['/assets/', '/assets'])('directory %s is not listed', async (url) => {
    const res = await get(url);
    expect(res.statusCode).not.toBe(200);
    expect(res.body).not.toContain('styles.css');
    expect(res.body).not.toContain('logout-redirect.js');
  });
});
