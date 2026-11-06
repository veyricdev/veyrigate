import { maskIp } from './mask-ip';

describe('maskIp (run 71, DEBT-344): network prefix only, never the stored string', () => {
  it.each([
    ['203.0.113.77', '203.0.113.0/24'],
    ['10.1.2.3', '10.1.2.0/24'],
    ['::ffff:203.0.113.77', '203.0.113.0/24'],
    ['::ffff:cb00:714d', '203.0.113.0/24'],
    ['2001:db8:abcd:12::1', '2001:db8:abcd::/48'],
    ['2001:0db8:abcd:0012:0000:0000:0000:0001', '2001:db8:abcd::/48'],
    ['fe80::1%eth0', 'fe80::/48'],
    ['::1', '::/48'],
  ])('%j => %j', (ip, masked) => {
    expect(maskIp(ip)).toBe(masked);
  });

  // DEBT-498: 6to4 (2002::/16) carries the full IPv4 in hextets 2-3, so a /48 would leak it.
  it.each([
    ['2002:cb00:714d::1', '203.0.113.0/24'],
    ['2002:c633:6417:1:2:3:4:5', '198.51.100.0/24'],
  ])('6to4 %j => IPv4 /24 %j (never the 4th octet)', (ip, masked) => {
    expect(maskIp(ip)).toBe(masked);
    expect(maskIp(ip)).not.toMatch(/\.(77|23)\//);
    expect(maskIp(ip)).not.toMatch(/714d|6417/);
  });

  it.each([
    [''],
    ['  '],
    [undefined],
    ['127.1'],
    ['0x7f.0.0.1'],
    ['010.0.0.1'],
    ['256.0.0.1'],
    ['10.0.0.0/8'],
    ['2001:db8::/32'],
    [' 203.0.113.77'],
    ['garbage'],
    [`2001:db8::1%${'x'.repeat(80)}`],
  ])('%j => absent (unparseable is never echoed)', (ip) => {
    expect(maskIp(ip)).toBeUndefined();
  });
});
