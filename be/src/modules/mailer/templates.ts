import type { MailMessage } from './mailer';

/**
 * Email templates (B1.10). Deliberately minimal: only the action link, the code for a link wrapper
 * that drops the fragment (DEBT-577, D86.3) and the expiry. No email address or name in the body.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function render(
  to: string,
  subject: string,
  intro: string,
  link: string,
  expiresInMinutes: number,
  code: string,
): MailMessage {
  const outro = `This link expires in ${expiresInMinutes} minutes. If you did not request this, ignore this email.`;
  const codeLine = 'If the link does not open the form, enter this code on the page:';
  const safeLink = escapeHtml(link);
  return {
    to,
    subject,
    text: `${intro}\n\n${link}\n\n${codeLine} ${code}\n\n${outro}\n`,
    html:
      `<p>${intro}</p><p><a href="${safeLink}">${safeLink}</a></p>` +
      `<p>${codeLine} <code>${escapeHtml(code)}</code></p><p>${outro}</p>`,
  };
}

export function verifyEmailMessage(
  to: string,
  link: string,
  expiresInMinutes: number,
  code: string,
): MailMessage {
  return render(
    to,
    'Verify your email',
    'Confirm your email address:',
    link,
    expiresInMinutes,
    code,
  );
}

export function resetPasswordMessage(
  to: string,
  link: string,
  expiresInMinutes: number,
  code: string,
): MailMessage {
  return render(to, 'Reset your password', 'Reset your password:', link, expiresInMinutes, code);
}

/**
 * Notice after a password change or reset (run 85, DEBT-573): no token, no one-time link; only the
 * time (UTC) and where to recover if the user did not do it.
 */
export function passwordChangedMessage(
  to: string,
  atIsoUtc: string,
  forgotUrl: string,
): MailMessage {
  const intro = `The password of your account was changed at ${atIsoUtc} (UTC). Every session was signed out.`;
  const outro = 'If you did not change it, reset your password now:';
  const safeLink = escapeHtml(forgotUrl);
  return {
    to,
    subject: 'Your password was changed',
    text: `${intro}\n\n${outro}\n${forgotUrl}\n`,
    html: `<p>${escapeHtml(intro)}</p><p>${outro} <a href="${safeLink}">${safeLink}</a></p>`,
  };
}

/** Run 89 (D89.18): the second factor changed. No code, no secret: a fixed text + `/account/mfa`. */
function mfaNotice(to: string, subject: string, intro: string, accountUrl: string): MailMessage {
  const outro = 'If this was not you, reset your password and review two-step verification:';
  const safeLink = escapeHtml(accountUrl);
  return {
    to,
    subject,
    text: `${intro}\n\n${outro}\n${accountUrl}\n`,
    html: `<p>${escapeHtml(intro)}</p><p>${outro} <a href="${safeLink}">${safeLink}</a></p>`,
  };
}

export function mfaEnabledMessage(to: string, atIsoUtc: string, accountUrl: string): MailMessage {
  return mfaNotice(
    to,
    'Two-step verification was turned on',
    `Two-step verification was turned on for your account at ${atIsoUtc} (UTC). Every session was signed out.`,
    accountUrl,
  );
}

export function mfaDisabledMessage(to: string, atIsoUtc: string, accountUrl: string): MailMessage {
  return mfaNotice(
    to,
    'Two-step verification was turned off',
    `Two-step verification was turned off for your account at ${atIsoUtc} (UTC). Every session was signed out.`,
    accountUrl,
  );
}

export function mfaRecoveryRegeneratedMessage(
  to: string,
  atIsoUtc: string,
  accountUrl: string,
): MailMessage {
  return mfaNotice(
    to,
    'New recovery codes were created',
    `New recovery codes for two-step verification were created at ${atIsoUtc} (UTC). Every older code no longer works.`,
    accountUrl,
  );
}

/** Run 89 T4 (D89.16): an administrator removed the user's second factor. */
export function mfaResetByAdminMessage(
  to: string,
  atIsoUtc: string,
  accountUrl: string,
): MailMessage {
  return mfaNotice(
    to,
    'Two-step verification was reset by an administrator',
    `Two-step verification was reset by an administrator for your account at ${atIsoUtc} (UTC). Every session was signed out. Set it up again before you use the admin console.`,
    accountUrl,
  );
}

/** Run 89 DEBT-640 (D89.25): too many wrong codes in a row; authenticator codes are refused. */
export function mfaLockedMessage(to: string, atIsoUtc: string, accountUrl: string): MailMessage {
  return mfaNotice(
    to,
    'Authenticator codes are blocked on your account',
    `Too many wrong two-step verification codes were entered for your account (last at ${atIsoUtc} UTC), so authenticator codes are no longer accepted. Someone else knows your password: change it. Sign in with a recovery code to unblock the codes.`,
    accountUrl,
  );
}
