import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateResourceDto } from '../admin/admin.dto';
import {
  InvalidResourceError,
  validateResourceFormat,
  validateResourceIdentifier,
} from './resource.validator';

const accepts = (v: string) => {
  try {
    validateResourceIdentifier(v);
    return true;
  } catch (err) {
    expect(err).toBeInstanceOf(InvalidResourceError);
    return false;
  }
};

describe('validateResourceIdentifier (write path, DEBT-324/329)', () => {
  it.each([
    ' https://a/',
    'https://a/ ',
    '\u0000https://a/',
    'https://a/\u0000',
    'https://a/b\tc',
    'https://a/b\nc',
    'https://a/b c',
    'https://a/\u00a0',
    'https://a/\u200b',
    'https://a/\u202e',
    'https://a/\ufeff',
    'https://a/\u2028',
    'https://a/\u007f',
    'javascript:alert(1)',
    'data:text/html,x',
    'file:///etc/passwd',
    'mailto:a@example.com',
    'a:',
    'https://a/#x',
    '/relative',
    '',
  ])('refuses %j', (v) => {
    expect(accepts(v)).toBe(false);
  });

  it.each([
    'https://api.example.com/',
    'HTTPS://A/',
    'http://localhost:3000/demo/',
    'urn:example:api',
    'https://ä.example/',
    'https://a/%20',
  ])('accepts %j', (v) => {
    expect(accepts(v)).toBe(true);
  });

  it('the message never echoes the input (control characters, scheme)', () => {
    for (const v of ['https://a/\u0000secret-x', 'javascript:secret-x']) {
      try {
        validateResourceIdentifier(v);
        throw new Error('accepted');
      } catch (err) {
        expect((err as Error).message).not.toContain('secret-x');
      }
    }
  });

  it('runtime validateResourceFormat is unchanged (a stored odd identifier is only "not found")', () => {
    expect(() => validateResourceFormat('javascript:alert(1)')).not.toThrow();
    expect(() => validateResourceFormat('https://a/b c')).not.toThrow();
  });
});

/**
 * The BE column of `fe-admin/test/resource-form-parity.test.ts`, MEASURED here with the real
 * write-path validators (DTO + `validateResourceIdentifier`). If a verdict changes, update that table.
 */
describe('fe-admin parity corpus: measured BE verdict of POST /admin/resources', () => {
  const x = (n: number) => 'x'.repeat(n);
  const E = '\u{1F600}';
  const be = (identifier: string) =>
    validateSync(plainToInstance(CreateResourceDto, { resourceId: 'demo', identifier }), {
      whitelist: true,
      forbidNonWhitelisted: true,
    }).length === 0 && accepts(identifier);

  it.each<[string, boolean]>([
    ['https://api.example.com/', true],
    ['urn:example:api', true],
    ['urn:', true],
    ['a:', false],
    ['https://a/#', true],
    ['https://a/?#', true],
    ['https://a/%23', true],
    ['https://a/#x', false],
    ['javascript:alert(1)', false],
    ['data:text/html,<b>x</b>', false],
    ['file:///etc/passwd', false],
    ['https://[::1]/', true],
    ['https://ä.example/', true],
    ['HTTPS://A/', true],
    ['https://a/ b', false],
    ['https:', false],
    ['https://', false],
    ['http://a b/', false],
    ['api.example.com', false],
    ['/relative', false],
    ['', false],
    [' ', false],
    [' https://a/', false],
    ['https://a/ ', false],
    ['\thttps://a/', false],
    ['https://a/\t', false],
    ['https://a/\u00a0', false],
    ['https://a/\ufeff', false],
    ['https://a/\u2028', false],
    ['\u0000https://a/', false],
    ['https://a/\u0000', false],
    ['https://a/b\tc', false],
    ['https://a/b\nc', false],
    ['https://a/\u200b', false],
    ['https://a/\u202e', false],
    [`https://a/${x(2038)}`, true],
    [`https://a/${x(2039)}`, false],
    [`https://a/${x(2036)}${E}`, true],
    [`https://a/${x(2037)}${E}`, true],
    [`https://a/${E.repeat(1020)}`, true],
  ])('%j => %p', (v, verdict) => {
    expect(be(v)).toBe(verdict);
  });
});
