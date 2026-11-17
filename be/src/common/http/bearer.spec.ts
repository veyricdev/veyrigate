import { bearerToken } from './bearer';
import type { HttpRequest } from './http.types';

const req = (authorization?: string | string[]) =>
  ({ headers: authorization === undefined ? {} : { authorization } }) as unknown as HttpRequest;

/** The pre-run-92 implementation: the accepted set must not change (CodeQL #1, D92.9). */
const legacy = (raw: string) => {
  const match = /^Bearer[ ]+(.+)$/i.exec(raw);
  return match ? match[1].trim() : undefined;
};

describe('bearerToken (CodeQL #1: no polynomial regex on the Authorization header)', () => {
  it.each([
    ['Bearer abc', 'abc'],
    ['bearer abc', 'abc'],
    ['BEARER   abc  ', 'abc'],
    ['Bearer a b', 'a b'],
    ['Bearer\tabc', undefined],
    ['Bearerabc', undefined],
    ['Bearer', undefined],
    ['Bearer ', undefined],
    ['Bearer  ', ''],
    ['Basic abc', undefined],
    ['Bearer abc\n', undefined],
    ['Bearer ab\rc', undefined],
    ['Bearer ab\u2028c', undefined],
    ['', undefined],
  ])('%j => %j (same as the legacy regex)', (raw, expected) => {
    expect(bearerToken(req(raw))).toBe(expected);
    expect(legacy(raw)).toBe(expected);
  });

  it('absent or repeated header => undefined', () => {
    expect(bearerToken(req())).toBeUndefined();
    expect(bearerToken(req(['Bearer a', 'Bearer b']))).toBeUndefined();
  });

  it.each([
    ['16 KiB of spaces, no token, trailing newline', `Bearer${' '.repeat(16 * 1024)}\n`, undefined],
    ['16 KiB of spaces then a token', `Bearer${' '.repeat(16 * 1024)}tok`, 'tok'],
    ['16 KiB of spaces only', `Bearer${' '.repeat(16 * 1024)}`, ''],
  ])('%s => same result as legacy, under 50 ms', (_name, raw, expected) => {
    const t0 = process.hrtime.bigint();
    const got = bearerToken(req(raw));
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(got).toBe(expected);
    expect(ms).toBeLessThan(50);
  });
});
