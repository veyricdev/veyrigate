import { jest } from '@jest/globals';
import ipaddr from 'ipaddr.js';
import { networkOf } from './login-throttle.service';

describe('networkOf (D85.2: IPv4 /32, IPv6 /64, IPv4-mapped => IPv4)', () => {
  it.each<[string | undefined, string]>([
    ['203.0.113.7', '203.0.113.7'],
    [' 203.0.113.7 ', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::FFFF:203.0.113.7', '203.0.113.7'],
    ['::ffff:cb00:7107', '203.0.113.7'],
    ['2001:db8::1', '2001:0db8:0000:0000'],
    ['2001:db8::ffff', '2001:0db8:0000:0000'],
    ['2001:DB8:0:0:abcd::1', '2001:0db8:0000:0000'],
    ['2001:db8:0:1::1', '2001:0db8:0000:0001'],
    ['2001:0db8:0000:0001:0000:0000:0000:0001', '2001:0db8:0000:0001'],
    ['::1', '0000:0000:0000:0000'],
    ['fe80::1%eth0', 'fe80:0000:0000:0000'],
    ['', 'unknown'],
    [undefined, 'unknown'],
    ['not-an-ip', 'unknown'],
    ['999.1.1.1', 'unknown'],
    ['2001:db8::1::2', 'unknown'],
  ])('%p => %p', (ip, network) => {
    expect(networkOf(ip)).toBe(network);
  });

  // DEBT-599 (D86.14): ipaddr.js parsing; the table above is the byte-for-byte regression (Redis
  // bucket keys must not change on deploy).
  it.each<[string | undefined, string]>([
    ['0:0:0:0:0:ffff:1.2.3.4', '1.2.3.4'],
    ['0000:0000:0000:0000:0000:ffff:1.2.3.4', '1.2.3.4'],
    ['::ffff:cb00:7107', '203.0.113.7'],
    ['fe80::1%eth0', 'fe80:0000:0000:0000'],
    ['127.1', 'unknown'],
    ['0x7f.0.0.1', 'unknown'],
    ['0177.0.0.1', 'unknown'],
    ['', 'unknown'],
    [undefined, 'unknown'],
    ['garbage', 'unknown'],
  ])('ipaddr.js: %p => %p', (ip, network) => {
    expect(networkOf(ip)).toBe(network);
  });

  it('an address Node accepts but ipaddr.js rejects => `unknown`, never a throw (no 5xx at /login)', () => {
    const spy = jest.spyOn(ipaddr, 'process').mockImplementation(() => {
      throw new Error('ipaddr: the address has neither IPv6 nor IPv4 format');
    });
    try {
      expect(networkOf('2001:db8::1')).toBe('unknown');
      expect(networkOf('203.0.113.7')).toBe('unknown');
    } finally {
      spy.mockRestore();
    }
  });

  it('compressed and expanded spellings of one /64 give the same network', () => {
    expect(networkOf('2001:db8:0:1::5')).toBe(networkOf('2001:0db8:0000:0001:0000:0000:0000:0005'));
    expect(networkOf('2001:DB8:0:1:0:0:0:5')).toBe(networkOf('2001:db8:0:1::5'));
  });

  it('two hosts of one /64 share a network; another /64 does not', () => {
    expect(networkOf('2001:db8::1')).toBe(networkOf('2001:db8::ffff'));
    expect(networkOf('2001:db8:0:1::1')).not.toBe(networkOf('2001:db8::1'));
    expect(networkOf('::ffff:203.0.113.7')).toBe(networkOf('203.0.113.7'));
  });
});
