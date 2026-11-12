import { deviceLabelFromUserAgent } from './device-label';

/** Run 88 T2 AC11 (D88.17): only allowlisted "<Browser> on <OS>" labels, never the raw User-Agent. */
const BROWSERS = ['Edge', 'Chrome', 'Firefox', 'Safari', 'Opera', 'Other'];
const OSES = ['Windows', 'macOS', 'iOS', 'Android', 'Linux', 'ChromeOS', 'Other'];
const ALLOWED = new Set(BROWSERS.flatMap((b) => OSES.map((o) => `${b} on ${o}`)));

describe('deviceLabelFromUserAgent', () => {
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Chrome on Windows',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0', 'Firefox on Linux'],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
      'Edge on Windows',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
      'Safari on macOS',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
      'Safari on iOS',
    ],
    [
      'Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1',
      'Chrome on iOS',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/133.0 Mobile/15E148 Safari/605.1.15',
      'Firefox on iOS',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.81 Mobile Safari/537.36',
      'Chrome on Android',
    ],
    ['Mozilla/5.0 (Android 14; Mobile; rv:133.0) Gecko/133.0 Firefox/133.0', 'Firefox on Android'],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 OPR/115.0.0.0',
      'Opera on Windows',
    ],
    [
      'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Chrome on ChromeOS',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:133.0) Gecko/20100101 Firefox/133.0',
      'Firefox on macOS',
    ],
    [
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Chrome on Linux',
    ],
    ['curl/8.10.1', 'Other on Other'],
    ['lightMyRequest', 'Other on Other'],
  ])('%s => %s', (ua, label) => {
    expect(deviceLabelFromUserAgent(ua)).toBe(label);
  });

  it.each([
    ['empty', ''],
    ['undefined', undefined],
    ['array header', ['a', 'b']],
    ['10 KB', 'Mozilla/5.0 '.repeat(900)],
    ['script tag', '<script>alert(1)</script> Chrome/1 (Windows NT 10.0)'],
    ['CRLF', 'Firefox/1\r\nSet-Cookie: x=1 (X11; Linux x86_64)'],
  ])('hostile/odd input (%s) => an allowlisted label only, never input text', (_n, ua) => {
    const label = deviceLabelFromUserAgent(ua as never);
    expect(ALLOWED.has(label)).toBe(true);
    expect(label).not.toMatch(/[<>\r\n]|script|Set-Cookie/);
  });
});
