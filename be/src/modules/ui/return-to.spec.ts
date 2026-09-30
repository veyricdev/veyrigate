import { describe, expect, it } from '@jest/globals';
import { safeReturnTo } from './return-to';

describe('safeReturnTo', () => {
  it.each(['/dashboard', '/path?q=1'])('accepts internal path %s', (value) =>
    expect(safeReturnTo(value, 'https://id.example.com')).toBe(value),
  );
  it.each(['https://evil.test', '//evil.test', '/\\evil.test', '/%0d%0a', 'javascript:alert(1)'])(
    'rejects unsafe value %s',
    (value) => expect(safeReturnTo(value, 'https://id.example.com')).toBe('/'),
  );
});
