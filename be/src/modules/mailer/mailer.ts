/** Outbound email (plan D10). Dev: SMTP → Mailpit; prod adapter chosen later. */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** DI token for the active `Mailer`. */
export const MAILER = Symbol('MAILER');
