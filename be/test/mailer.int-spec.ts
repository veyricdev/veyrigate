import { randomUUID } from 'node:crypto';
import { SmtpMailer } from '../src/modules/mailer/smtp.mailer';
import { verifyEmailMessage } from '../src/modules/mailer/templates';

const SMTP_URL = process.env.TEST_SMTP_URL ?? 'smtp://localhost:1025';
const MAILPIT_API = process.env.TEST_MAILPIT_API ?? 'http://localhost:8025';

describe('SmtpMailer → Mailpit (B1.10)', () => {
  it('delivers the verify-email message; Mailpit shows only the link', async () => {
    const tag = randomUUID();
    const to = `int-${tag}@example.test`;
    const link = `http://localhost:4000/verify?t=${tag}`;
    await new SmtpMailer(SMTP_URL, 'no-reply@localhost').send(verifyEmailMessage(to, link, 30));

    const search = await fetch(
      `${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`,
    );
    const { messages } = (await search.json()) as { messages: { ID: string; Subject: string }[] };
    expect(messages).toHaveLength(1);
    expect(messages[0].Subject).toBe('Verify your email');

    const msg = (await (await fetch(`${MAILPIT_API}/api/v1/message/${messages[0].ID}`)).json()) as {
      From: { Address: string };
      Text: string;
      HTML: string;
    };
    expect(msg.From.Address).toBe('no-reply@localhost');
    expect(msg.Text).toContain(link);
    expect(msg.Text).not.toContain(to);
    expect(msg.HTML).not.toContain(to);
  });
});
