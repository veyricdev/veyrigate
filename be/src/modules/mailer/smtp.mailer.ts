import { createTransport, type Transporter } from 'nodemailer';
import type { MailMessage, Mailer } from './mailer';

/** SMTP adapter (nodemailer). Timeouts bound every phase so a stuck SMTP server cannot hang a request. */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = createTransport({
      url: smtpUrl,
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 10000,
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }
}
