import { describe, expect, it } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { CsrfService } from './csrf.service';

describe('CsrfService', () => {
  const service = new CsrfService({
    getOrThrow: () => ({ csrfSecret: 'a'.repeat(32) }),
  } as unknown as ConfigService);

  it('binds a token to its session or anonymous cookie identity', () => {
    const token = service.token('identity-a');
    expect(service.verify('identity-a', token)).toBe(true);
    expect(service.verify('identity-b', token)).toBe(false);
    expect(service.verify('identity-a', `${token}x`)).toBe(false);
  });
});
