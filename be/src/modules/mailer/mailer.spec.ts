import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { SmtpMailer } from './smtp.mailer';
import { resetPasswordMessage, verifyEmailMessage } from './templates';

describe('Mailer templates (B1.10)', () => {
  const to = 'alice.secret@example.test';
  const link = 'https://id.example.test/verify?t=abc&x="><script>alert(1)</script>';

  it.each([
    ['verify', verifyEmailMessage(to, link, 30)],
    ['reset', resetPasswordMessage(to, link, 15)],
  ])('%s: body has only the escaped link + expiry, no recipient data', (_name, msg) => {
    expect(msg.to).toBe(to);
    // No email/local-part in the body.
    for (const body of [msg.text, msg.html]) {
      expect(body).not.toContain('alice');
      expect(body).not.toContain(to);
    }
    // HTML is escaped: no raw tag injection.
    expect(msg.html).not.toContain('<script>');
    expect(msg.html).toContain('&lt;script&gt;');
    expect(msg.html).toContain('&amp;x=&quot;&gt;');
    // Token only appears inside the link (once in text, twice in html: href + label).
    expect(msg.text.split('t=abc').length - 1).toBe(1);
    expect(msg.html.split('t=abc').length - 1).toBe(2);
    expect(msg.text).toMatch(/expires in \d+ minutes/);
  });
});

describe('SmtpMailer timeout (B1.10)', () => {
  let server: Server;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    // Accepts TCP but never sends the SMTP greeting.
    server = createServer((s) => sockets.push(s));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });

  afterAll(async () => {
    sockets.forEach((s) => s.destroy());
    await new Promise((r) => server.close(r));
  });

  it('fails instead of hanging when the SMTP server never greets', async () => {
    const { port } = server.address() as AddressInfo;
    const mailer = new SmtpMailer(`smtp://127.0.0.1:${port}`, 'no-reply@localhost');
    const started = Date.now();
    await expect(
      mailer.send({ to: 'x@example.test', subject: 's', text: 't', html: '<p>t</p>' }),
    ).rejects.toThrow(/greeting|timeout/i);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(4500);
    expect(elapsed).toBeLessThan(9000);
  }, 15000);
});
