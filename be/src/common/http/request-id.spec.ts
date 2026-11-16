import { createFastifyAdapter } from './framework-errors';
import { requestIdFrom } from './request-id';

/**
 * DEBT-095 (run 90 C1, D90.10): one request id source. Fastify `genReqId` (built by the single adapter
 * factory) accepts a client `x-request-id` only when it is a short safe token, otherwise mints a UUID;
 * every response echoes the chosen id; `req.id` (audit `requestId`, pino `req.id`) is that same id.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('requestIdFrom', () => {
  it.each([['abc'], ['pt-req-123'], ['A.b_c:d-9'], ['x'.repeat(64)]])(
    'keeps the safe id %p',
    (id) => {
      expect(requestIdFrom({ headers: { 'x-request-id': id } })).toBe(id);
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
    expect(requestIdFrom({ headers: { 'x-request-id': value } })).toMatch(UUID);
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
  const adapter = createFastifyAdapter(false);
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
