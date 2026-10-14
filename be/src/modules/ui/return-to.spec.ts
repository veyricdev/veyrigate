import { describe, expect, it } from '@jest/globals';
import { requestIdFromReturnTo, safeReturnTo } from './return-to';

describe('safeReturnTo', () => {
  it.each(['/dashboard', '/path?q=1'])('accepts internal path %s', (value) =>
    expect(safeReturnTo(value, 'https://id.example.com')).toBe(value),
  );
  it.each(['https://evil.test', '//evil.test', '/\\evil.test', '/%0d%0a', 'javascript:alert(1)'])(
    'rejects unsafe value %s',
    (value) => expect(safeReturnTo(value, 'https://id.example.com')).toBe('/'),
  );
});

describe('requestIdFromReturnTo (DEBT-084)', () => {
  it('extracts the id from exactly /authorize?request_id=<id>', () => {
    expect(requestIdFromReturnTo('/authorize?request_id=abc123')).toBe('abc123');
  });
  it.each([
    ['no query', '/authorize'],
    ['root', '/'],
    ['empty id', '/authorize?request_id='],
    ['extra query key', '/authorize?request_id=X&redirect_uri=https://evil.example'],
    ['leading extra key', '/authorize?foo=1&request_id=X'],
    ['consent path', '/authorize/consent?request_id=X'],
    ['different path', '/login?request_id=X'],
    ['wrong key', '/authorize?req=X'],
  ])('returns null for %s', (_label, value) => {
    expect(requestIdFromReturnTo(value)).toBeNull();
  });
});
