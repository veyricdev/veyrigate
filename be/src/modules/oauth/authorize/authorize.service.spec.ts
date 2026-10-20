import { AUTHORIZE_PARAM_KEYS, repeatedParam } from './authorize.service';

// DEBT-204/205 (run 35): Fastify parses a repeated query parameter into an array; any recognised
// `/authorize` parameter whose value is not absent/a single string counts as repeated.
describe('repeatedParam', () => {
  it.each(AUTHORIZE_PARAM_KEYS)('%s: string or absent => ok; array/object => repeated', (key) => {
    expect(repeatedParam({ [key]: 'v' })).toBeUndefined();
    expect(repeatedParam({ [key]: '' })).toBeUndefined();
    expect(repeatedParam({ [key]: undefined })).toBeUndefined();
    expect(repeatedParam({})).toBeUndefined();
    expect(repeatedParam({ [key]: ['a', 'b'] })).toBe(key);
    expect(repeatedParam({ [key]: { a: 'b' } })).toBe(key);
  });

  it('an unrecognised parameter is ignored even when repeated (RFC 6749 §3.1)', () => {
    expect(repeatedParam({ utm: ['1', '2'], scope: 'openid' })).toBeUndefined();
  });

  it('only the given keys are checked; the first repeated one in key order is returned', () => {
    const params = { scope: ['a', 'b'], client_id: ['c', 'd'] };
    expect(repeatedParam(params, ['client_id', 'redirect_uri'])).toBe('client_id');
    expect(repeatedParam(params, ['redirect_uri'])).toBeUndefined();
    expect(repeatedParam(params)).toBe('client_id');
  });
});
