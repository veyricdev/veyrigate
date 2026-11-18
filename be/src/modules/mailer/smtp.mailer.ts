import { Logger, type OnApplicationShutdown } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { observeMailDropped, setMailQueueDepth } from '../../common/metrics/metrics';
import { isDeliverableEmail } from '../../common/validation/email-address';
import type { MailMessage, Mailer } from './mailer';

/**
 * Most mails the SMTP mailer holds at once (sending + queued in the pool), run 95 (DEBT-683, D95.9).
 * With SMTP hanging, the 200th waits ~200/5 x 10 s = 400 s, well under the reset/verify token TTL.
 */
export const MAX_PENDING_MAIL = 200;

/**
 * SMTP adapter (nodemailer). Timeouts bound every phase so a stuck SMTP server cannot hang a request.
 * Run 94 (DEBT-664, D94.9): a pool of at most 5 connections (each reused for 100 messages), so a burst of
 * detached sends never opens one connection per mail. Closed at shutdown (`onApplicationShutdown`): the
 * D91.11 drain does not wait for mail, so a message still queued then is rejected ("Connection pool was
 * closed"), i.e. lost; the caller's `.catch` sees it (verify/reset mail: `auth_mail` counter, D91.3).
 * Run 95 (DEBT-683, D95.10-D95.12): at most MAX_PENDING_MAIL unsettled sends, counted here (nodemailer
 * does not expose its queue length); beyond that a send rejects at once without touching the transport.
 * Drops are counted in `sso_mail_dropped_total` only: callers already count `auth_mail` and log.
 */
export class SmtpMailer implements Mailer, OnApplicationShutdown {
  private readonly logger = new Logger(SmtpMailer.name);
  private readonly transport: Transporter;
  private pending = 0;

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
    if (this.pending >= MAX_PENDING_MAIL) {
      observeMailDropped('queue_full');
      throw new Error('mailer: queue full');
    }
    setMailQueueDepth(++this.pending);
    try {
      await this.transport.sendMail({ from: this.from, ...message });
    } finally {
      setMailQueueDepth(--this.pending);
    }
  }

  onApplicationShutdown(): void {
    const n = this.pending;
    if (n > 0) {
      observeMailDropped('shutdown', n);
      this.logger.warn(`mail queue closed with ${n} unsent message(s)`);
    }
    this.transport.close();
  }
}
