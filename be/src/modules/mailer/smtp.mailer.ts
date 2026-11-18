import type { OnApplicationShutdown } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { isDeliverableEmail } from '../../common/validation/email-address';
import type { MailMessage, Mailer } from './mailer';

/**
 * SMTP adapter (nodemailer). Timeouts bound every phase so a stuck SMTP server cannot hang a request.
 * Run 94 (DEBT-664, D94.9): a pool of at most 5 connections (each reused for 100 messages), so a burst of
 * detached sends never opens one connection per mail. Closed at shutdown (`onApplicationShutdown`): the
 * D91.11 drain does not wait for mail, so a message still queued then is rejected ("Connection pool was
 * closed"), i.e. lost; the caller's `.catch` sees it (verify/reset mail: `auth_mail` counter, D91.3).
 * The queue is unbounded (DEBT-683).
 */
export class SmtpMailer implements Mailer, OnApplicationShutdown {
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = createTransport({
      url: smtpUrl,
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
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

  onApplicationShutdown(): void {
    this.transport.close();
  }
}
