import { BadRequestException } from '@nestjs/common';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertAcceptablePassword,
  COMMON_PASSWORD_MESSAGE,
  loadCommonPasswords,
  PASSWORD_LENGTH_MESSAGE,
} from './password-policy';

const LIST = join(process.cwd(), 'src/modules/authentication/password-policy/common-passwords.txt');
const lines = readFileSync(LIST, 'utf8').split('\n');

const refusal = (password: string, ctx?: { email?: string }): string | undefined => {
  try {
    assertAcceptablePassword(password, ctx);
    return undefined;
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as BadRequestException).message;
  }
};
/** Fullwidth form of printable ASCII (NFKC folds it back). */
const fullwidth = (s: string) =>
  [...s]
    .map((c) => (c > ' ' && c <= '~' ? String.fromCharCode(c.charCodeAt(0) + 0xfee0) : c))
    .join('');

describe('common-passwords.txt (D85.4)', () => {
  const entries = lines.slice(0, -1);

  it('is LF, ends with a newline, 10 000 unique lowercase NFKC entries of length 8-128', () => {
    expect(lines.at(-1)).toBe('');
    expect(readFileSync(LIST, 'utf8')).not.toContain('\r');
    expect(entries.length).toBe(10_000);
    expect(new Set(entries).size).toBe(entries.length);
    for (const e of entries) {
      expect(e).toBe(e.normalize('NFKC').toLowerCase());
      expect(e.length).toBeGreaterThanOrEqual(8);
      expect(e.length).toBeLessThanOrEqual(128);
    }
  });
});

describe('assertAcceptablePassword (DEBT-574)', () => {
  const entries = lines.slice(0, -1);
  const samples = [entries[0], entries[4999], entries[entries.length - 1]];

  it.each(samples)('refuses the list entry %p, also upper-case and fullwidth', (entry) => {
    expect(refusal(entry)).toBe(COMMON_PASSWORD_MESSAGE);
    expect(refusal(entry.toUpperCase())).toBe(COMMON_PASSWORD_MESSAGE);
    expect(refusal(fullwidth(entry))).toBe(COMMON_PASSWORD_MESSAGE);
  });

  it('refuses product words and the email (local part >= 4, or the whole address)', () => {
    expect(refusal('veyrigate2026!')).toBe(COMMON_PASSWORD_MESSAGE);
    expect(refusal('my-SSO-IdP-pass')).toBe(COMMON_PASSWORD_MESSAGE);
    expect(refusal('ssoidp#2026xyz')).toBe(COMMON_PASSWORD_MESSAGE);
    expect(refusal('alice.smith#2026', { email: 'alice.smith@example.com' })).toBe(
      COMMON_PASSWORD_MESSAGE,
    );
    expect(refusal('ALICE.SMITH#2026', { email: 'alice.smith@example.com' })).toBe(
      COMMON_PASSWORD_MESSAGE,
    );
    expect(refusal('bob@example.com', { email: 'bob@example.com' })).toBe(COMMON_PASSWORD_MESSAGE);
    // A 3-character local part is too short to be a context word.
    expect(refusal('x7#Qbob2!vLp9@zR', { email: 'bob@example.com' })).toBeUndefined();
  });

  it('accepts a strong password, keeps the length rule and never echoes the input', () => {
    expect(refusal('x7#Qm2!vLp9@zR4w')).toBeUndefined();
    expect(refusal('x7#Qm2!vLp9@zR4w', { email: 'alice.smith@example.com' })).toBeUndefined();
    expect(refusal('short')).toBe(PASSWORD_LENGTH_MESSAGE);
    expect(refusal('a'.repeat(129))).toBe(PASSWORD_LENGTH_MESSAGE);
    expect(refusal(entries[0])).not.toContain(entries[0]);
  });
});

describe('loadCommonPasswords (fail-closed)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vg-pwlist-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('throws on a missing, empty or too short file; accepts >= 3000 entries', () => {
    expect(() => loadCommonPasswords(join(dir, 'missing.txt'))).toThrow();
    writeFileSync(join(dir, 'empty.txt'), '');
    expect(() => loadCommonPasswords(join(dir, 'empty.txt'))).toThrow();
    const short = Array.from({ length: 2999 }, (_, i) => `password${i}`).join('\n') + '\n';
    writeFileSync(join(dir, 'short.txt'), short);
    expect(() => loadCommonPasswords(join(dir, 'short.txt'))).toThrow();
    writeFileSync(join(dir, 'ok.txt'), short + 'password2999\n');
    expect(loadCommonPasswords(join(dir, 'ok.txt')).size).toBe(3000);
  });
});
