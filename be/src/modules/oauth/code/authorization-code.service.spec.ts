import type { RedisService } from '../../../database/redis/redis.service';
import { AuthorizationCodeService, type AuthorizationCodeData } from './authorization-code.service';

const DATA: AuthorizationCodeData = {
  clientId: 'c',
  redirectUri: 'https://app.example.com/cb',
  codeChallenge: 'ch',
  resource: 'https://api.example.com/',
  scope: 'openid',
  userId: 'u',
  sessionRef: 's',
};

/** In-memory Redis double: `get` and the consume script may answer different stored values. */
function service(getRaw: string | null, consumeRaw: string | null) {
  const calls: string[] = [];
  const client = {
    defineCommand: () => undefined,
    get: async () => (calls.push('get'), getRaw),
    consumeAuthCode: async () => (calls.push('consume'), consumeRaw),
  };
  return { svc: new AuthorizationCodeService({ client } as unknown as RedisService), calls };
}

describe('AuthorizationCodeService.peek / consume(expectedRaw) (DEBT-388)', () => {
  const raw = JSON.stringify(DATA);

  it('peek: binding match ⇒ {raw, data}; GET only (never DEL / consume)', async () => {
    const { svc, calls } = service(raw, raw);
    expect(await svc.peek('code', 'c', DATA.redirectUri, 'ch')).toEqual({ raw, data: DATA });
    expect(calls).toEqual(['get']);
  });

  it.each([
    ['client_id', 'x', DATA.redirectUri, 'ch'],
    ['redirect_uri', 'c', 'https://evil.example.com/cb', 'ch'],
    ['code_challenge', 'c', DATA.redirectUri, 'other'],
  ])('peek: wrong %s ⇒ null', async (_n, clientId, redirectUri, challenge) => {
    const { svc } = service(raw, raw);
    expect(await svc.peek('code', clientId, redirectUri, challenge)).toBeNull();
  });

  it('peek: missing code / empty input ⇒ null', async () => {
    expect(await service(null, null).svc.peek('code', 'c', DATA.redirectUri, 'ch')).toBeNull();
    expect(await service(raw, raw).svc.peek('', 'c', DATA.redirectUri, 'ch')).toBeNull();
  });

  it('consume: consumed value === peeked value ⇒ data', async () => {
    const { svc } = service(raw, raw);
    expect(await svc.consume('code', 'c', DATA.redirectUri, 'ch', raw)).toEqual(DATA);
  });

  it('consume: consumed value ≠ peeked value ⇒ null (the signed tokens are not for it)', async () => {
    const other = JSON.stringify({ ...DATA, userId: 'someone-else' });
    const { svc } = service(raw, other);
    expect(await svc.consume('code', 'c', DATA.redirectUri, 'ch', raw)).toBeNull();
  });
});
