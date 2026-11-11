import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootFullApp, type FullApp } from './full-app';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';

/**
 * Run 83 tester (deps-security), on the REAL app (`AppModule` + `configureApp`): what the
 * `@fastify/static` 10.1.10 / `@fastify/send` 4.2.1 / fastify 5.12.7 upgrade could change on
 * `/assets/` that `static-assets.int-spec.ts` does not pin yet:
 * - conditional GET (ETag / Last-Modified => 304 without a body), HEAD, byte ranges (206 / 416);
 * - more traversal encodings that reach `/assets/` undecoded (double encoding, encoded backslash,
 *   NUL, a Windows drive path, an encoded slash): never 200, never the content of a file outside
 *   `public/`, never a 5xx.
 *   (The unmatched-route 404 echoes the request path in `error_description`: Nest default, see
 *   DEBT-559; not asserted here.)
 */
describe('run 83 tester: /assets/ after the @fastify/static 10.1.10 upgrade', () => {
  let full: FullApp;
  let css = '';
  let outsideMarker = '';
  const publicDir = join(process.cwd(), 'src', 'public');

  const boot = async (): Promise<void> => {
    css = await readFile(join(publicDir, 'styles.css'), 'utf8');
    outsideMarker = (await readFile(join(publicDir, '..', 'app.module.ts'), 'utf8')).slice(0, 40);
    full = await bootFullApp({ name: 'run83-static' });
  };
  let setup: Promise<void> | undefined;
  beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await settled(setup);
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);

  const req = (method: 'GET' | 'HEAD', url: string, headers: Record<string, string> = {}) =>
    full.app.inject({ method, url, headers });

  describe('caching validators', () => {
    it('200 carries an ETag, Last-Modified and a revalidating Cache-Control', async () => {
      const res = await req('GET', '/assets/styles.css');
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(css);
      // @fastify/send emits a weak validator (W/"size-mtime").
      expect(String(res.headers.etag)).toMatch(/^(W\/)?"[^"]+"$/);
      expect(Number.isNaN(Date.parse(String(res.headers['last-modified'])))).toBe(false);
      expect(String(res.headers['cache-control'])).toMatch(/max-age=0/);
      expect(String(res.headers['cache-control'])).not.toMatch(/no-store/);
    });

    it('If-None-Match with the ETag => 304, empty body', async () => {
      const first = await req('GET', '/assets/styles.css');
      const res = await req('GET', '/assets/styles.css', {
        'if-none-match': String(first.headers.etag),
      });
      expect(res.statusCode).toBe(304);
      expect(res.body).toBe('');
    });

    it('If-Modified-Since = Last-Modified => 304, empty body', async () => {
      const first = await req('GET', '/assets/styles.css');
      const res = await req('GET', '/assets/styles.css', {
        'if-modified-since': String(first.headers['last-modified']),
      });
      expect(res.statusCode).toBe(304);
      expect(res.body).toBe('');
    });

    it('a stale ETag => full 200 again', async () => {
      const res = await req('GET', '/assets/styles.css', { 'if-none-match': '"stale-run83"' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(css);
    });
  });

  describe('HEAD and ranges', () => {
    it('HEAD => 200, same length as GET, no body', async () => {
      const res = await req('HEAD', '/assets/styles.css');
      expect(res.statusCode).toBe(200);
      expect(Number(res.headers['content-length'])).toBe(Buffer.byteLength(css));
      expect(res.body).toBe('');
    });

    it('Range bytes=0-9 => 206 with exactly the first 10 bytes', async () => {
      const res = await req('GET', '/assets/styles.css', { range: 'bytes=0-9' });
      expect(res.statusCode).toBe(206);
      expect(String(res.headers['content-range'])).toBe(`bytes 0-9/${Buffer.byteLength(css)}`);
      expect(res.rawPayload.equals(Buffer.from(css).subarray(0, 10))).toBe(true);
    });

    it('unsatisfiable Range => 416, no file content', async () => {
      const res = await req('GET', '/assets/styles.css', { range: 'bytes=99999999-' });
      expect(res.statusCode).toBe(416);
      expect(res.body).not.toContain(css.slice(0, 20));
    });
  });

  describe('traversal encodings', () => {
    it.each([
      '/assets/%252e%252e/app.module.ts',
      '/assets/%252e%252e%252fapp.module.ts',
      '/assets/..%5c..%5cpackage.json',
      '/assets/%2e%2e%5c%2e%2e%5cpackage.json',
      '/assets/..%00/app.module.ts',
      '/assets/C:%5cWindows%5cwin.ini',
      '/assets/%2fetc%2fhosts',
    ])('%s => not 200, nothing outside public/, no 5xx', async (url) => {
      const res = await req('GET', url);
      expect(res.statusCode).not.toBe(200);
      expect(res.statusCode).toBeLessThan(500);
      expect(res.body).not.toContain(outsideMarker);
      expect(res.body).not.toContain('"@sso-idp/be"');
      expect(res.body).not.toContain('[fonts]');
      expect(res.body).not.toContain('localhost');
    });
  });
});
