import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { IsEmail, validateSync } from 'class-validator';
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

/**
 * Run 83 T1 AC2: the envelope (RCPT TO) is what decides where a verify/reset mail lands. A fake SMTP
 * server records every RCPT TO; hostile `to` values built on the nodemailer addressparser advisories
 * must never smuggle a recipient at evil.test (or the send must reject).
 */
describe('SmtpMailer envelope vs hostile addresses (run 83)', () => {
  let server: Server;
  const sockets: Socket[] = [];
  let rcpts: string[] = [];

  beforeAll(async () => {
    server = createServer((s) => {
      sockets.push(s);
      let buf = '';
      let inData = false;
      s.write('220 fake.test ESMTP\r\n');
      s.on('data', (chunk) => {
        buf += chunk.toString('latin1');
        let i: number;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (inData) {
            if (line === '.') {
              inData = false;
              s.write('250 queued\r\n');
            }
            continue;
          }
          const verb = line.slice(0, 4).toUpperCase();
          if (verb === 'EHLO' || verb === 'HELO') s.write('250 fake.test\r\n');
          else if (verb === 'MAIL') s.write('250 ok\r\n');
          else if (verb === 'RCPT') {
            rcpts.push(line.replace(/^RCPT TO:/i, ''));
            s.write('250 ok\r\n');
          } else if (verb === 'DATA') {
            inData = true;
            s.write('354 go\r\n');
          } else if (verb === 'QUIT') {
            s.end('221 bye\r\n');
          } else s.write('250 ok\r\n');
        }
      });
      s.on('error', () => undefined);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });

  afterAll(async () => {
    sockets.forEach((s) => s.destroy());
    await new Promise((r) => server.close(r));
  });

  async function rcptsFor(to: string): Promise<{ rcpts: string[]; rejected: boolean }> {
    const { port } = server.address() as AddressInfo;
    const mailer = new SmtpMailer(`smtp://127.0.0.1:${port}`, 'no-reply@good.test');
    rcpts = [];
    let rejected = false;
    try {
      await mailer.send({ to, subject: 's', text: 't', html: '<p>t</p>' });
    } catch (err) {
      // Only nodemailer's own envelope refusal counts as "rejected"; a connection error or timeout must
      // fail the test instead of skipping its assertions (DEBT-555).
      if ((err as { code?: string }).code !== 'EENVELOPE') throw err;
      rejected = true;
    }
    return { rcpts, rejected };
  }

  it('baseline: one RCPT TO for a plain address', async () => {
    const r = await rcptsFor('victim@good.test');
    expect(r.rejected).toBe(false);
    expect(r.rcpts).toEqual(['<victim@good.test>']);
  });

  // The smuggled domain is evil.test; a quoted local part may still spell "evil.test" as text, so the
  // check is on the RCPT domain (after the last "@"). `exact` pins the expected envelope where the
  // advisory is about the local part rather than the domain.
  it.each<[string, string, string[] | undefined]>([
    // GHSA-85x2: ">" inside a quoted local part ends the angle-addr early.
    ['GHSA-85x2 quoted ">"', 'Victim <"x>, attacker@evil.test, "@good.test>', undefined],
    // GHSA-m943: ";" inside a quoted string ends the group early.
    ['GHSA-m943 quoted ";"', 'g:"a;attacker@evil.test"@good.test;', undefined],
    // GHSA-8c8m: a nested comment ends early and releases the rest as a recipient.
    ['GHSA-8c8m nested comment', '(a (b) attacker@evil.test c) victim@good.test', undefined],
    // GHSA-g73g: a comment inside an angle-addr is never stripped.
    [
      'GHSA-g73g comment in angle-addr',
      '<(attacker@evil.test)victim@good.test>',
      ['<victim@good.test>'],
    ],
  ])('%s: no RCPT TO at evil.test', async (_name, to, exact) => {
    const r = await rcptsFor(to);
    if (r.rejected) return;
    const domains = r.rcpts.map((x) => x.replace(/>$/, '').split('@').pop());
    expect(domains).not.toContain('evil.test');
    if (exact) expect(r.rcpts).toEqual(exact);
  });

  // Quoted local parts that @IsEmail() accepts (see the characterization below): one RCPT, at good.test.
  it.each(['"a;attacker@evil.test"@good.test', '"x>attacker@evil.test"@good.test'])(
    'IsEmail-accepted %s: exactly one RCPT TO, at good.test',
    async (to) => {
      const r = await rcptsFor(to);
      expect(r.rejected).toBe(false);
      expect(r.rcpts).toHaveLength(1);
      expect(r.rcpts[0]).toMatch(/@good\.test>$/);
    },
  );
});

/**
 * Run 83 T1 AC3 (characterization only, input for DEBT-550): what the `@IsEmail()` used by
 * RegisterDto/EmailDto (ui.controller.ts) does with the hostile strings above. No behaviour change.
 */
describe('@IsEmail() on hostile addresses (run 83, characterization)', () => {
  class EmailOnly {
    @IsEmail() email!: string;
  }
  const accepts = (email: string) =>
    validateSync(Object.assign(new EmailOnly(), { email })).length === 0;

  it.each([
    ['Victim <"x>, attacker@evil.test, "@good.test>', false],
    ['g:"a;attacker@evil.test"@good.test;', false],
    ['(a (b) attacker@evil.test c) victim@good.test', false],
    ['<(attacker@evil.test)victim@good.test>', false],
    // Quoted local parts pass today; DEBT-550 would reject them at the boundary.
    ['"a;attacker@evil.test"@good.test', true],
    ['"x>attacker@evil.test"@good.test', true],
  ])('%s => accepted=%s', (email, expected) => {
    expect(accepts(email)).toBe(expected);
  });
});
