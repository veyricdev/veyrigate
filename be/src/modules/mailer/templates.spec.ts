import { describe, expect, it } from '@jest/globals';
import {
  mfaDisabledMessage,
  mfaEnabledMessage,
  mfaLockedMessage,
  mfaRecoveryRegeneratedMessage,
  mfaResetByAdminMessage,
} from './templates';

/** Run 89 T2 (D89.18): the MFA notices carry a fixed text and the account link, never a secret. */
describe('MFA notice mails', () => {
  const URL_ = 'https://idp.example.com/account/mfa';
  it.each([
    ['enabled', mfaEnabledMessage, /turned on/],
    ['disabled', mfaDisabledMessage, /turned off/],
    ['recovery regenerated', mfaRecoveryRegeneratedMessage, /recovery codes/],
    ['reset by an administrator (T4)', mfaResetByAdminMessage, /reset by an administrator/],
    ['authenticator codes blocked (DEBT-640)', mfaLockedMessage, /blocked/],
  ])('%s: subject + link, no code / secret / otpauth', (_n, build, re) => {
    const m = build('u@example.com', '2026-11-12T10:00:00.000Z', URL_);
    expect(m.to).toBe('u@example.com');
    expect(m.subject).toMatch(re);
    expect(m.text).toContain(URL_);
    expect(m.html).toContain(`href="${URL_}"`);
    for (const body of [m.text, m.html]) {
      expect(body).not.toMatch(/otpauth|secret=|[A-Z2-7]{16,}|\b\d{6}\b|[0-9A-Z]{4}-[0-9A-Z]{4}/);
    }
  });
});
