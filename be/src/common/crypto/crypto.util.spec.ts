import { randomBytes } from 'node:crypto';
import {
  constantTimeEqual,
  generateToken,
  hashPassword,
  sha256,
  verifyPassword,
} from './crypto.util';

describe('crypto.util', () => {
  describe('hashPassword / verifyPassword', () => {
    it('hashes and verifies a correct password', async () => {
      const hash = await hashPassword('correct horse battery staple');
      expect(hash).toMatch(/^\$argon2id\$/);
      await expect(verifyPassword(hash, 'correct horse battery staple')).resolves.toBe(true);
    });

    it('rejects an incorrect password', async () => {
      const hash = await hashPassword('correct horse battery staple');
      await expect(verifyPassword(hash, 'wrong password')).resolves.toBe(false);
    });
  });

  describe('generateToken', () => {
    it('returns url-safe tokens of the requested entropy', () => {
      const token = generateToken(32);
      expect(token).not.toContain('=');
      expect(token).not.toContain('+');
      expect(token).not.toContain('/');
      // 32 bytes base64url → 43 chars
      expect(token).toHaveLength(43);
    });

    it('is not Math.random — produces distinct values', () => {
      const a = generateToken();
      const b = generateToken();
      expect(a).not.toBe(b);
    });
  });

  describe('sha256', () => {
    it('matches a known vector for the empty string', () => {
      expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });
  });

  describe('constantTimeEqual', () => {
    it('returns true for equal strings', () => {
      const token = randomBytes(16).toString('hex');
      expect(constantTimeEqual(token, token)).toBe(true);
    });

    it('returns false for different strings', () => {
      expect(constantTimeEqual('abc', 'abd')).toBe(false);
    });

    it('returns false for different lengths', () => {
      expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    });
  });
});
