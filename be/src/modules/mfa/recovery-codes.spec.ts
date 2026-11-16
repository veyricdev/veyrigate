import { describe, expect, it } from '@jest/globals';
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  newRecoverySalt,
  normalizeRecoveryCode,
} from './recovery-codes';

/** Run 89 T1 AC9 (D89.11): 10 codes x 16 Crockford characters (80 bits), stored as salted hashes. */
describe('recovery codes', () => {
  it('10 distinct codes shown as XXXX-XXXX-XXXX-XXXX in the Crockford alphabet', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    }
  });

  it('normalizes typing: case, dashes, spaces, O->0, I/L->1', () => {
    expect(normalizeRecoveryCode('abcd-efgh-jkmn-pqrs')).toBe('ABCDEFGHJKMNPQRS');
    expect(normalizeRecoveryCode(' oO0i IlL1 tvwx yz23 ')).toBe('00011111TVWXYZ23');
  });

  it.each(['', 'ABCD-EFGH-JKMN-PQR', 'ABCD-EFGH-JKMN-PQRST', 'ABCD-EFGH-JKMN-PQRU', '123456'])(
    'rejects %j (wrong length or letter outside the alphabet)',
    (bad) => {
      expect(normalizeRecoveryCode(bad)).toBeNull();
    },
  );

  it('hash = sha256(salt || code) hex; salt 16 random bytes; the code itself is not in the hash', () => {
    const salt = newRecoverySalt();
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(newRecoverySalt()).not.toBe(salt);
    const h = hashRecoveryCode(salt, 'ABCDEFGHJKMNPQRS');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecoveryCode(salt, 'ABCDEFGHJKMNPQRS')).toBe(h);
    expect(hashRecoveryCode(newRecoverySalt(), 'ABCDEFGHJKMNPQRS')).not.toBe(h);
  });
});
