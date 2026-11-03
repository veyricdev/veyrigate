import { randomBytes } from 'node:crypto';
import { connect, type AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { bootFullApp, type FullApp } from './full-app';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';

/**
 * Run 59 tester (DEBT-239/443): pre-routing framework errors (`onBadUrl` 400, `onMaxParamLength`
 * 414) on the REAL listening app over a raw socket (byte-exact request targets, no inject
 * normalisation). The helmet header set is NOT a fixed list: it is taken from a live reference 404
 * (every header but the transport/representation ones), so a helmet upgrade that adds a header to
 * normal responses but not to `frameworkErrors` turns this red (DEBT-443).
 */
const METRICS_TOKEN = randomBytes(32).toString('hex');
const RUN = randomBytes(6).toString('hex');
/** Not helmet: transport/representation headers that legitimately differ per response. */
const NOT_HELMET = new Set([
  'content-type',
  'content-length',
  'date',
  'connection',
  'keep-alive',
  'cache-control',
  'vary',
  'transfer-encoding',
]);
/** Floor: the 12 helmet headers the fold names must at least be in the reference. */
const FLOOR = [
  'content-security-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'origin-agent-cluster',
  'referrer-policy',
  'strict-transport-security',
  'x-content-type-options',
  'x-dns-prefetch-control',
  'x-download-options',
  'x-frame-options',
  'x-permitted-cross-domain-policies',
  'x-xss-protection',
];

interface RawRes {
  status: number;
  headers: Record<string, string>;
  body: string;
  raw: string;
}

/** Parse one or more HTTP/1.1 responses (content-length framed) from a byte string. */
function parseAll(text: string): RawRes[] {
  const out: RawRes[] = [];
  let rest = text;
  while (rest.length > 0) {
    const split = rest.indexOf('\r\n\r\n');
    if (split < 0) break;
    const [statusLine, ...lines] = rest.slice(0, split).split('\r\n');
    const headers: Record<string, string> = {};
    for (const line of lines) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
    }
    const len = Number(headers['content-length'] ?? 0);
    const status = Number(statusLine.split(' ')[1]);
    const bodyLen = headers['content-length'] === undefined ? 0 : len;
    const end = split + 4 + bodyLen;
    out.push({ status, headers, body: rest.slice(split + 4, end), raw: rest.slice(0, end) });
    rest = rest.slice(end);
  }
  return out;
}

describe('run 59 tester: pre-routing framework errors on the real listening app (raw socket)', () => {
  let full: FullApp;
  let port = 0;
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(...String(chunk).split('\n').filter(Boolean));
      cb();
    },
  });
  let ref: RawRes;
  let helmet: string[] = [];

  /** One request (or several pipelined, last one `Connection: close`) on one socket. */
  function send(payload: string): Promise<RawRes[]> {
    return new Promise((resolve, reject) => {
      const sock = connect(port, '127.0.0.1');
      let buf = '';
      sock.setEncoding('latin1');
      sock.on('data', (d: string) => (buf += d));
      sock.on('error', reject);
      sock.on('close', () => resolve(parseAll(buf)));
      sock.write(payload);
    });
  }
  const req = (method: string, target: string, extra = '') =>
    `${method} ${target} HTTP/1.1\r\nHost: idp.example\r\n${extra}`;
  const one = async (method: string, target: string, extra = '') =>
    (await send(`${req(method, target, extra)}Connection: close\r\n\r\n`))[0];

  async function metrics(): Promise<string> {
    const r = await one('GET', '/metrics', `Authorization: Bearer ${METRICS_TOKEN}\r\n`);
    expect(r.status).toBe(200);
    return r.body;
  }
  function count(body: string, match: (line: string) => boolean): number {
    let sum = 0;
    for (const line of body.split('\n')) {
      if (!line.startsWith('sso_http_request_duration_seconds_count{') || !match(line)) continue;
      sum += Number(line.slice(line.lastIndexOf(' ') + 1));
    }
    return sum;
  }
  const unmatched4 = (b: string, method?: string) =>
    count(
      b,
      (l) =>
        l.includes('route="__unmatched"') &&
        l.includes('status_class="4xx"') &&
        (!method || l.includes(`method="${method}"`)),
    );
  const all5 = (b: string) => count(b, (l) => l.includes('status_class="5xx"'));
  const errorLines = () => lines.filter((l) => /"level":(50|60)/.test(l)).length;
  const settle = () => new Promise((r) => setImmediate(r));

  // DEBT-448: afterAll waits for a setup that outlived its hook, then cleans up what it opened.
  const boot = async (): Promise<void> => {
    full = await bootFullApp({ name: 'tester59edge', env: { METRICS_TOKEN }, logStream: stream });
    await full.app.listen(0, '127.0.0.1');
    port = (full.app.getHttpServer().address() as AddressInfo).port;
    ref = await one('GET', `/nope-${RUN}`);
    expect(ref.status).toBe(404);
    helmet = Object.keys(ref.headers)
      .filter((h) => !NOT_HELMET.has(h) && !h.startsWith('x-ratelimit') && h !== 'x-request-id')
      .sort();
    console.info(`[run59-tester] reference 404 security headers (${helmet.length}): ${helmet}`);
  };
  let setup: Promise<void> | undefined;
  beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await settled(setup);
    await full?.close();
  }, INT_SETUP_TIMEOUT_MS);

  const expectParity = (res: RawRes) => {
    for (const h of helmet) expect([h, res.headers[h]]).toEqual([h, ref.headers[h]]);
  };

  it('DEBT-443: the reference list is derived from a live 404 and covers at least the 12 fold headers', () => {
    for (const h of FLOOR) expect(helmet).toContain(h);
  });

  const LONG = 'a'.repeat(101);
  const cases: Array<[string, string, string, number, string[]]> = [
    ['GET', 'bad %E0 under /assets', '/assets/%E0%A4%A', 400, ['%E0', 'assets']],
    ['GET', 'bad %zz unmatched', `/nope-${RUN}/%zz%`, 400, ['%zz', RUN]],
    ['GET', 'lone %', '/%', 400, []],
    [
      'GET',
      'encoded CRLF + bad escape',
      `/x${RUN}/%0d%0aSet-Cookie:%20pwn=1%zz`,
      400,
      ['pwn', RUN],
    ],
    ['GET', 'XSS-shaped + bad escape', `/x/%3Cscript%3E${RUN}%zz`, 400, [RUN, '%3C']],
    ['GET', 'param 101 chars', `/admin/users/${LONG}`, 414, ['aaaa', 'admin']],
    ['GET', 'param 5000 chars', `/admin/users/${'b'.repeat(5000)}`, 414, ['bbbb']],
    [
      'GET',
      'param 101 encoded payload',
      `/admin/users/%3Cscript%3E${RUN}${LONG}`,
      414,
      [RUN, '%3C'],
    ],
    ['POST', 'POST bad escape with body', `/token/%zz${RUN}`, 400, ['%zz', RUN, 'pwn1234']],
    ['DELETE', 'DELETE param too long', `/admin/users/${LONG}`, 414, ['aaaa']],
    ['OPTIONS', 'OPTIONS bad escape', `/x/%zz${RUN}`, 400, [RUN]],
  ];

  it.each(cases)(
    '%s %s => fixed JSON, helmet parity, no-store, no echo, no ERROR log, one __unmatched 4xx',
    async (method, _name, target, status, markers) => {
      const before = await metrics();
      const errBefore = errorLines();
      const linesBefore = lines.length;
      const extra =
        method === 'POST'
          ? 'Content-Type: application/x-www-form-urlencoded\r\nContent-Length: 18\r\n'
          : '';
      const body = method === 'POST' ? 'grant_type=pwn1234' : '';
      const [res] = await send(`${req(method, target, extra)}Connection: close\r\n\r\n${body}`);
      await settle();
      expect(res.status).toBe(status);
      expect(res.body).toBe('{"error":"invalid_request"}');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.headers['location']).toBeUndefined();
      expectParity(res);
      // no echo anywhere in the raw response (status line + headers + body)
      for (const m of markers) expect([m, res.raw.includes(m)]).toEqual([m, false]);
      // log sink: no ERROR, and the URL never reaches any log line
      expect(errorLines()).toBe(errBefore);
      const newLines = lines.slice(linesBefore).join('\n');
      for (const m of markers) expect([m, newLines.includes(m)]).toEqual([m, false]);
      const after = await metrics();
      const label =
        method === 'OPTIONS' || method === 'DELETE' || method === 'POST' ? method : 'GET';
      expect(unmatched4(after, label)).toBe(unmatched4(before, label) + 1);
      expect(all5(after)).toBe(all5(before));
      // the metric labels never carry the raw URL
      for (const m of markers) expect([m, after.includes(m)]).toEqual([m, false]);
    },
  );

  it('HEAD bad escape => 400, no body, same headers', async () => {
    const before = await metrics();
    const res = await one('HEAD', `/x/%zz${RUN}`);
    expect(res.status).toBe(400);
    expect(res.headers['cache-control']).toBe('no-store');
    expectParity(res);
    expect(res.raw.includes(RUN)).toBe(false);
    expect(unmatched4(await metrics(), 'HEAD')).toBe(unmatched4(before, 'HEAD') + 1);
  });

  it('unknown method (PROPFIND) => method label OTHER, never the raw method', async () => {
    const before = await metrics();
    const res = await one('PROPFIND', `/x/%zz${RUN}`);
    expect(res.status).toBe(400);
    expectParity(res);
    const after = await metrics();
    expect(unmatched4(after, 'OTHER')).toBe(unmatched4(before, 'OTHER') + 1);
    expect(after).not.toContain('method="PROPFIND"');
  });

  it('request chain: bad URL then a normal request on the SAME keep-alive socket', async () => {
    const pipelined =
      `${req('GET', `/x/%zz${RUN}`)}\r\n` +
      `${req('GET', `/nope-${RUN}-second`)}Connection: close\r\n\r\n`;
    const responses = await send(pipelined);
    // the connection survives (or is closed cleanly); if the second answer arrives it is the normal 404
    expect(responses[0].status).toBe(400);
    expectParity(responses[0]);
    if (responses.length > 1) {
      expect(responses[1].status).toBe(404);
      expectParity(responses[1]);
    }
    console.info(
      `[run59-tester] keep-alive after framework error: ${responses.length} response(s)`,
    );
  });

  it('concurrency: 40 parallel bad URLs => all 400/414, exactly +40 __unmatched 4xx, 0 5xx, 0 ERROR', async () => {
    const before = await metrics();
    const errBefore = errorLines();
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        one('GET', i % 2 ? `/x/%zz${i}` : `/admin/users/${'c'.repeat(101 + i)}`),
      ),
    );
    await settle();
    expect(results.map((r) => r.status).sort()).toEqual(
      [...Array(20).fill(400), ...Array(20).fill(414)].sort(),
    );
    for (const r of results) expect(r.body).toBe('{"error":"invalid_request"}');
    const after = await metrics();
    expect(unmatched4(after)).toBe(unmatched4(before) + 40);
    expect(all5(after)).toBe(all5(before));
    expect(errorLines()).toBe(errBefore);
  });

  it('regression: a valid 100-char param still routes (not 414) and a valid escape still routes', async () => {
    const before = await metrics();
    const r100 = await one('GET', `/admin/users/${'a'.repeat(100)}`);
    expect(r100.status).not.toBe(414);
    expect(r100.status).toBe(401); // reaches the admin guard: no bearer
    const ok = await one('GET', `/nope-${RUN}/%41`);
    expect(ok.status).toBe(404);
    expectParity(ok);
    expect(unmatched4(await metrics())).toBe(unmatched4(before) + 1); // only the /nope 404 is __unmatched
  });
});
