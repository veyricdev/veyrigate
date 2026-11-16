import { describe, expect, it, jest } from '@jest/globals';
import { hotp, totpAt, totpInternals, totpStep, verifyTotp } from './totp';

/** Run 89 T1 AC1/AC3 (D89.10): RFC 4226 / RFC 6238 vectors and the ±1 step window. */
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('hotp (RFC 4226 appendix D)', () => {
  it.each([
    [0, '755224'],
    [1, '287082'],
    [2, '359152'],
    [3, '969429'],
    [4, '338314'],
    [5, '254676'],
    [6, '287922'],
    [7, '162583'],
    [8, '399871'],
    [9, '520489'],
  ])('counter %i => %s', (counter, code) => {
    expect(hotp(RFC_SECRET, counter, 6)).toBe(code);
  });
});

describe('totpAt (RFC 6238 appendix B, SHA-1, 8 digits)', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('T = %i => %s', (t, code) => {
    expect(totpAt(RFC_SECRET, totpStep(t * 1000), 8)).toBe(code);
  });
});

describe('verifyTotp (D89.10)', () => {
  const secret = Buffer.from('0123456789abcdef0123', 'ascii');
  const now = 1_800_000_000_000;
  const c = totpStep(now);
  const code = (step: number) => totpAt(secret, step);

  it('accepts c-1, c and c+1 and returns the matched step', () => {
    expect(verifyTotp(secret, code(c - 1), now)).toBe(c - 1);
    expect(verifyTotp(secret, code(c), now)).toBe(c);
    expect(verifyTotp(secret, code(c + 1), now)).toBe(c + 1);
  });

  it('spaces are ignored; anything but 6 digits => null', () => {
    const k = code(c);
    expect(verifyTotp(secret, `${k.slice(0, 3)} ${k.slice(3)}`, now)).toBe(c);
    for (const bad of ['', '12345', '1234567', 'abcdef', `${k}x`, '١٢٣٤٥٦']) {
      expect(verifyTotp(secret, bad, now)).toBeNull();
    }
  });

  it.each<[string, () => [string, number | undefined]]>([
    ['code of c+2', () => [code(c + 2), undefined]],
    ['code of c-2', () => [code(c - 2), undefined]],
    ['code of c-1 when lastStep = c-1', () => [code(c - 1), c - 1]],
    ['right code but lastStep = c', () => [code(c), c]],
    ['code of c+1 when lastStep = c+1', () => [code(c + 1), c + 1]],
  ])('%s => null', (_n, args) => {
    const [k, last] = args();
    expect(verifyTotp(secret, k, now, last)).toBeNull();
  });

  it('code of c+1 when lastStep = c => c+1 (a later step is still new)', () => {
    expect(verifyTotp(secret, code(c + 1), now, c)).toBe(c + 1);
  });

  it('compares all three steps with a constant-time compare (no early exit)', () => {
    const spy = jest.spyOn(totpInternals, 'equal');
    try {
      verifyTotp(secret, code(c - 1), now);
      expect(spy).toHaveBeenCalledTimes(3);
      spy.mockClear();
      verifyTotp(secret, '000000', now);
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
  });
});
