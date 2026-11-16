import { createFastifyAdapter } from './framework-errors';
import { requestIdFrom, trustedProxies } from './request-id';

/**
 * DEBT-095 (run 90 C1, D90.10): one request id source. Fastify `genReqId` (built by the single adapter
 * factory) accepts a client `x-request-id` only when it is a short safe token, otherwise mints a UUID;
 * every response echoes the chosen id; `req.id` (audit `requestId`, pino `req.id`) is that same id.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A request from a trusted proxy (run 91, D91.10): `TRUST_PROXY` lists 10.0.0.0/8. */
const PROXY = trustedProxies(['10.0.0.0/8']);
const viaProxy = (headers: Record<string, string | string[] | undefined>) => ({
  headers,
  socket: { remoteAddress: '10.1.2.3' },
});

describe('requestIdFrom', () => {
  it.each([['abc'], ['pt-req-123'], ['A.b_c:d-9'], ['x'.repeat(64)]])(
    'keeps the safe id %p',
    (id) => {
      expect(requestIdFrom(viaProxy({ 'x-request-id': id }), PROXY)).toBe(id);
    },
  );

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['65 chars', 'x'.repeat(65)],
    ['8 KB', 'r'.repeat(8192)],
    ['CR LF', 'abc\r\nSet-Cookie: pwn=1'],
    ['percent-encoded CR LF', 'abc%0d%0aSet-Cookie'],
    ['space', 'a b'],
    ['joined duplicate', 'a, b'],
    ['array', ['a', 'b']],
    ['non-ASCII', 'idé'],
  ])('replaces the %s value by a fresh UUID', (_name, value) => {
    expect(requestIdFrom(viaProxy({ 'x-request-id': value }), PROXY)).toMatch(UUID);
  });

  describe('DEBT-667 (d), D91.10: a client id only from a TRUST_PROXY address', () => {
    const header = { 'x-request-id': 'pt-req-123' };
    it('no TRUST_PROXY: a valid header is ignored (fresh UUID)', () => {
      expect(requestIdFrom({ headers: header, socket: { remoteAddress: '10.1.2.3' } })).toMatch(
        UUID,
      );
      expect(
        requestIdFrom(
          { headers: header, socket: { remoteAddress: '10.1.2.3' } },
          trustedProxies(false),
        ),
      ).toMatch(UUID);
    });
    it.each([
      ['10.1.2.3', 'pt-req-123'],
      ['::ffff:10.1.2.3', 'pt-req-123'],
    ])('TRUST_PROXY=10.0.0.0/8, socket %s => keeps the header', (remoteAddress, want) => {
      expect(requestIdFrom({ headers: header, socket: { remoteAddress } }, PROXY)).toBe(want);
    });
    it.each([['203.0.113.5'], ['::ffff:203.0.113.5'], ['2001:db8::1'], [undefined]])(
      'TRUST_PROXY=10.0.0.0/8, socket %s => fresh UUID',
      (remoteAddress) => {
        expect(requestIdFrom({ headers: header, socket: { remoteAddress } }, PROXY)).toMatch(UUID);
      },
    );
    it('single addresses and IPv6 subnets are honoured too', () => {
      const list = trustedProxies(['192.0.2.7', 'fd00::/8']);
      expect(requestIdFrom({ headers: header, socket: { remoteAddress: '192.0.2.7' } }, list)).toBe(
        'pt-req-123',
      );
      expect(requestIdFrom({ headers: header, socket: { remoteAddress: 'fd00::5' } }, list)).toBe(
        'pt-req-123',
      );
      expect(
        requestIdFrom({ headers: header, socket: { remoteAddress: '192.0.2.8' } }, list),
      ).toMatch(UUID);
    });
  });

  it('two requests without a header get two different UUIDs (no req-N counter)', () => {
    const a = requestIdFrom({ headers: {} });
    const b = requestIdFrom({ headers: {} });
    expect(a).toMatch(UUID);
    expect(b).toMatch(UUID);
    expect(a).not.toBe(b);
  });
});

describe('createFastifyAdapter request id', () => {
  // `inject` comes from 127.0.0.1: trusted here, so a client id is honoured (D91.10).
  const adapter = createFastifyAdapter(['127.0.0.1']);
  const fastify = adapter.getInstance();
  fastify.get('/rid', async (req) => ({ id: req.id }));

  afterAll(() => fastify.close());

  it('echoes a valid client id and uses it as req.id', async () => {
    const res = await fastify.inject({ url: '/rid', headers: { 'x-request-id': 'pt-req-123' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe('pt-req-123');
    expect(res.json()).toEqual({ id: 'pt-req-123' });
  });

  it.each([
    ['8 KB', 'r'.repeat(8192)],
    ['empty', ''],
    ['bad chars', 'a<b>"c'],
  ])(
    'a %s client id is never echoed: a fresh UUID is, and req.id equals it (no 4xx/5xx)',
    async (_name, value) => {
      const res = await fastify.inject({ url: '/rid', headers: { 'x-request-id': value } });
      expect(res.statusCode).toBe(200);
      const echoed = res.headers['x-request-id'];
      expect(echoed).toMatch(UUID);
      expect(res.json()).toEqual({ id: echoed });
    },
  );

  it('DEBT-667 (e): a `request-id` header (requestIdHeader stays false) is never the request id', async () => {
    const res = await fastify.inject({ url: '/rid', headers: { 'request-id': 'pt-other-123' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).not.toBe('pt-other-123');
    expect(res.headers['x-request-id']).toMatch(UUID);
    expect(res.json()).toEqual({ id: res.headers['x-request-id'] });
  });

  it('no header: each response echoes its own UUID', async () => {
    const [a, b] = await Promise.all([
      fastify.inject({ url: '/rid' }),
      fastify.inject({ url: '/rid' }),
    ]);
    expect(a.headers['x-request-id']).toMatch(UUID);
    expect(b.headers['x-request-id']).toMatch(UUID);
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
  });
});

describe('createFastifyAdapter request id without TRUST_PROXY (run 91, D91.10)', () => {
  const fastify = createFastifyAdapter(false).getInstance();
  fastify.get('/rid', async (req) => ({ id: req.id }));
  afterAll(() => fastify.close());

  it('a valid client id is NOT used: a fresh UUID is echoed and is req.id', async () => {
    const res = await fastify.inject({ url: '/rid', headers: { 'x-request-id': 'pt-req-123' } });
    expect(res.headers['x-request-id']).toMatch(UUID);
    expect(res.json()).toEqual({ id: res.headers['x-request-id'] });
  });
});
