import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { enrollAad, MfaKeyring, parseMfaKeys, totpAad } from './mfa-crypto';

/** Run 89 T1 AC4 (D89.12): env keyring + AES-256-GCM with a per-user AAD. */
const k = (byte: number) => Buffer.alloc(32, byte).toString('base64');

describe('parseMfaKeys', () => {
  it('kid:base64 list, first = current', () => {
    const keys = parseMfaKeys(`k2:${k(2)}, k1:${k(1)}`);
    expect(keys.map((x) => x.kid)).toEqual(['k2', 'k1']);
    expect(keys[0].key.equals(Buffer.alloc(32, 2))).toBe(true);
  });

  it.each([
    ['empty', '', /MFA_ENCRYPTION_KEYS/],
    ['no colon', k(1), /entry 1/],
    ['bad kid', `K1:${k(1)}`, /entry 1/],
    ['kid too long', `${'a'.repeat(17)}:${k(1)}`, /entry 1/],
    ['16-byte key', `k1:${Buffer.alloc(16, 1).toString('base64')}`, /entry 1/],
    ['not base64', `k1:${'!'.repeat(44)}`, /entry 1/],
    ['duplicate kid', `k1:${k(1)},k1:${k(2)}`, /entry 2/],
    ['empty entry', `k1:${k(1)},,`, /entry 2/],
  ])('%s => throws naming the position, never the value', (_n, raw, re) => {
    let message = '';
    try {
      parseMfaKeys(raw);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(re);
    expect(message).not.toContain(k(1));
    expect(message).not.toContain(k(2));
  });
});

describe('MfaKeyring', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });
  const ring = new MfaKeyring(parseMfaKeys(`k1:${k(1)}`));
  const secret = randomBytes(20);
  const A = '65f000000000000000000001';
  const B = '65f000000000000000000002';

  it('seal/open round-trip; iv 12 bytes random, tag 16 bytes, kid = current', () => {
    const a = ring.seal(secret, totpAad(A));
    const b = ring.seal(secret, totpAad(A));
    expect(a.kid).toBe('k1');
    expect(Buffer.from(a.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(a.tag, 'base64')).toHaveLength(16);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toContain(secret.toString('base64'));
    expect(ring.open(a, totpAad(A))?.equals(secret)).toBe(true);
  });

  it.each([
    ['AAD of another user', (s: ReturnType<MfaKeyring['seal']>) => [s, totpAad(B)] as const],
    [
      'enrollment AAD instead of the stored one',
      (s: ReturnType<MfaKeyring['seal']>) => [s, enrollAad(A)] as const,
    ],
    [
      'tag with one bit flipped',
      (s: ReturnType<MfaKeyring['seal']>) => {
        const tag = Buffer.from(s.tag, 'base64');
        tag[0] ^= 1;
        return [{ ...s, tag: tag.toString('base64') }, totpAad(A)] as const;
      },
    ],
    [
      'unknown kid',
      (s: ReturnType<MfaKeyring['seal']>) => [{ ...s, kid: 'k9' }, totpAad(A)] as const,
    ],
    [
      'iv of 11 bytes',
      (s: ReturnType<MfaKeyring['seal']>) =>
        [{ ...s, iv: randomBytes(11).toString('base64') }, totpAad(A)] as const,
    ],
    [
      'short tag',
      (s: ReturnType<MfaKeyring['seal']>) =>
        [
          { ...s, tag: Buffer.from(s.tag, 'base64').subarray(0, 8).toString('base64') },
          totpAad(A),
        ] as const,
    ],
  ])('%s => null (never throws), ERROR log without ciphertext or user id', (_n, mutate) => {
    const errors: string[] = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => {
      errors.push(String(m));
    });
    const [sealed, aad] = mutate(ring.seal(secret, totpAad(A)));
    expect(ring.open(sealed, aad, 'req-1')).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('req-1');
    for (const leak of [sealed.ct, A, B, sealed.iv]) expect(errors[0]).not.toContain(leak);
  });

  it('rotation: a secret sealed under an older kid still opens; new seals use the current kid', () => {
    const old = new MfaKeyring(parseMfaKeys(`k1:${k(1)}`)).seal(secret, totpAad(A));
    const rotated = new MfaKeyring(parseMfaKeys(`k2:${k(2)},k1:${k(1)}`));
    expect(rotated.currentKid).toBe('k2');
    expect(rotated.open(old, totpAad(A))?.equals(secret)).toBe(true);
    expect(rotated.seal(secret, totpAad(A)).kid).toBe('k2');
  });
});
