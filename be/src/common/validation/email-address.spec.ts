import { validateSync } from 'class-validator';
import { DELIVERABLE_EMAIL_MESSAGE, IsDeliverableEmail, isDeliverableEmail } from './email-address';

/** Run 84 T1 (D84.1, DEBT-550/556): the narrow `local@domain` grammar for every mail/account path. */
describe('isDeliverableEmail (D84.1)', () => {
  const local64 = 'l'.repeat(64);
  const label63 = 'd'.repeat(63);
  // 64 + 1 + 189 = 254: domain = 3 labels of 61 + "." x2 + ".io" (61*3 + 2 + 3 = 188) + 1 => 189.
  const domain189 = `${'a'.repeat(61)}.${'b'.repeat(61)}.${'c'.repeat(62)}.io`;

  it.each([
    'a@b.co',
    'first.last+tag@sub.example.com',
    "o'brien@example.io",
    'x@xn--bcher-kva.de',
    'under_score-dash@x-y.example',
    'UPPER@EXAMPLE.COM',
    'a@x.xn--p1ai',
    `${local64}@x.io`,
    `a@${label63}.io`,
    `${local64}@${domain189}`,
  ])('accepts %j', (email) => {
    expect(isDeliverableEmail(email)).toBe(true);
  });

  it('length fixtures are what their names say', () => {
    expect(`${local64}@${domain189}`).toHaveLength(254);
    expect(domain189.length).toBeLessThanOrEqual(253);
  });

  it.each<[string, unknown]>([
    // run 83 mailer.spec hostile strings (nodemailer addressparser GHSAs).
    ['GHSA-85x2', 'Victim <"x>, attacker@evil.test, "@good.test>'],
    ['GHSA-m943', 'g:"a;attacker@evil.test"@good.test;'],
    ['GHSA-8c8m', '(a (b) attacker@evil.test c) victim@good.test'],
    ['GHSA-g73g', '<(attacker@evil.test)victim@good.test>'],
    ['angle-addr', '<victim@good.test>'],
    ['display name', 'Victim <victim@good.test>'],
    // DEBT-556: quoted local parts @IsEmail() accepts and nodemailer rewrites.
    ['DEBT-556 quoted >', '"x>attacker@evil.test"@good.test'],
    ['DEBT-556 quoted ;', '"a;attacker@evil.test"@good.test'],
    ['quoted plain', '"a"@x.io'],
    ['space', 'a b@x.io'],
    ['CRLF', 'a\r\n@x.io'],
    ['LF at end', 'a@x.io\n'],
    ['tab', 'a\t@x.io'],
    ['NUL', 'a\u0000@x.io'],
    ['DEL', 'a\u007f@x.io'],
    ['leading space', ' a@x.io'],
    ['trailing space', 'a@x.io '],
    ['leading dot', '.a@x.io'],
    ['trailing dot', 'a.@x.io'],
    ['double dot', 'a..b@x.io'],
    ['percent relay', 'a%b@x.io'],
    ['bang relay', 'a!b@x.io'],
    ['comma', 'a,b@x.io'],
    ['semicolon', 'a;b@x.io'],
    ['colon', 'a:b@x.io'],
    ['backslash', 'a\\b@x.io'],
    ['quoted-pair', '"a\\"b"@x.io'],
    ['backspace', 'a\u0008b@x.io'],
    ['brackets', 'a[b]@x.io'],
    ['parens', 'a(b)@x.io'],
    ['hash', 'a#b@x.io'],
    ['equals', 'a=b@x.io'],
    ['tilde', 'a~b@x.io'],
    ['pipe', 'a|b@x.io'],
    ['backtick', 'a`b@x.io'],
    ['IP literal', 'a@[1.2.3.4]'],
    ['IPv4 domain', 'a@1.2.3.4'],
    ['numeric TLD', 'a@x.123'],
    ['single label', 'a@localhost'],
    ['trailing dot domain', 'a@x.io.'],
    ['empty label', 'a@x..io'],
    ['leading dot domain', 'a@.x.io'],
    ['label leading hyphen', 'a@-x.io'],
    ['label trailing hyphen', 'a@x-.io'],
    ['underscore in domain', 'a@x_y.io'],
    ['U-label local', 'ü@x.io'],
    ['U-label domain', 'a@bücher.de'],
    ['fullwidth at', 'a＠x.io'],
    ['local 65', `${'l'.repeat(65)}@x.io`],
    ['label 64', `a@${'d'.repeat(64)}.io`],
    ['total 255', `${local64}@${domain189}x`],
    ['domain 254', `a@${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(59)}.io`],
    ['empty', ''],
    ['double at', 'a@@x.io'],
    ['two ats', 'a@b@x.io'],
    ['no local', '@x.io'],
    ['no domain', 'a@'],
    ['no at', 'a.x.io'],
    ['number', 42],
    ['null', null],
    ['undefined', undefined],
    ['array', ['a@b.co']],
    ['object', { toString: () => 'a@b.co' }],
  ])('rejects %s', (_name, value) => {
    expect(isDeliverableEmail(value)).toBe(false);
  });

  it('the domain-254 fixture is 254 characters', () => {
    expect(
      `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(59)}.io`,
    ).toHaveLength(254);
  });
});

describe('@IsDeliverableEmail()', () => {
  class Dto {
    @IsDeliverableEmail() email!: unknown;
  }
  const errorsFor = (email: unknown) => validateSync(Object.assign(new Dto(), { email }));

  it('passes a plain address', () => {
    expect(errorsFor('a@b.co')).toHaveLength(0);
  });

  it('rejects a quoted local part with the fixed message, never the value', () => {
    const errors = errorsFor('"x>attacker@evil.test"@good.test');
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toEqual({ isDeliverableEmail: DELIVERABLE_EMAIL_MESSAGE });
    expect(JSON.stringify(errors[0].constraints)).not.toContain('evil.test');
  });
});
