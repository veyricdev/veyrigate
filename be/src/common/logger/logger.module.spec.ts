import { describe, expect, it } from '@jest/globals';
import { serializeRequest } from './logger.module';

describe('request log serializer', () => {
  it('drops query strings containing one-time tokens', () => {
    expect(serializeRequest({ method: 'GET', url: '/reset?token=top-secret' })).toEqual({
      method: 'GET',
      url: '/reset',
    });
    expect(
      JSON.stringify(serializeRequest({ method: 'GET', url: '/verify-email?token=top-secret' })),
    ).not.toContain('top-secret');
  });
});
