import type { MailMessage } from './mailer';

/**
 * Email templates (B1.10). Deliberately minimal: only the action link and
 * its expiry. No email address, name, or bare token in the body.
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
): MailMessage {
  const outro = `This link expires in ${expiresInMinutes} minutes. If you did not request this, ignore this email.`;
  const safeLink = escapeHtml(link);
  return {
    to,
    subject,
    text: `${intro}\n\n${link}\n\n${outro}\n`,
    html: `<p>${intro}</p><p><a href="${safeLink}">${safeLink}</a></p><p>${outro}</p>`,
  };
}

export function verifyEmailMessage(
  to: string,
  link: string,
  expiresInMinutes: number,
): MailMessage {
  return render(to, 'Verify your email', 'Confirm your email address:', link, expiresInMinutes);
}

export function resetPasswordMessage(
  to: string,
  link: string,
  expiresInMinutes: number,
): MailMessage {
  return render(to, 'Reset your password', 'Reset your password:', link, expiresInMinutes);
}
