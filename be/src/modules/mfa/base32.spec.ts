import { describe, expect, it } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { base32Decode, base32Encode, newTotpSecret } from './base32';

/** Run 89 T1 AC2: RFC 4648 base32 without padding. */
describe('base32', () => {
  it.each([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('RFC 4648 vector %j => %s (no padding)', (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain, 'ascii'))).toBe(encoded);
    expect(base32Decode(encoded).toString('ascii')).toBe(plain);
  });

  it('round-trips 1000 random buffers', () => {
    for (let i = 0; i < 1000; i++) {
      const buf = randomBytes(1 + (i % 40));
      expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    }
  });

  it.each(['MZXW6=', 'mzxw6', 'MZ1W6', 'MZ0W6', 'MZ W6', 'MZ8'])(
    'decode rejects %j (character outside the alphabet)',
    (bad) => {
      expect(() => base32Decode(bad)).toThrow();
    },
  );

  it('a new secret is 20 random bytes => 32 characters', () => {
    const a = newTotpSecret();
    const b = newTotpSecret();
    expect(a).toHaveLength(20);
    expect(base32Encode(a)).toMatch(/^[A-Z2-7]{32}$/);
    expect(a.equals(b)).toBe(false);
  });
});
