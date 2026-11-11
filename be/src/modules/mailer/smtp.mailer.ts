import { createTransport, type Transporter } from 'nodemailer';
import { isDeliverableEmail } from '../../common/validation/email-address';
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
    // Defence in depth (run 84 D84.1): a recipient outside the narrow grammar never reaches the
    // address parser of the transport. Fixed message: the address is not echoed into logs.
    if (!isDeliverableEmail(message.to)) throw new Error('mailer: recipient rejected');
    await this.transport.sendMail({ from: this.from, ...message });
  }
}
