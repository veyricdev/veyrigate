import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { sha256 } from '../../common/crypto/crypto.util';
import { registry } from '../../common/metrics/metrics';
import type { RateLimitService } from '../security/rate-limit/rate-limit.service';
import {
  ClientAuthenticationService,
  ClientAuthRateLimitedError,
  InvalidClientError,
} from './client-authentication.service';
import type { ClientCredentialService } from './client-credential.service';
import type { Client, ClientService } from './client.service';

/**
 * Run 97 T1 (DEBT-072, D97.14/D97.17): the global per-`client_id` failure cap, unit level (stubbed
 * Redis scripts). The real Redis/Lua behaviour is in `test/client-auth-rate-limit.int-spec.ts`.
 */
const CLIENT_ID = 'rp-1';
const IP = '203.0.113.7';
const TAG = sha256(CLIENT_ID);

async function limited(scope: string): Promise<number> {
  const { values } = await registry.getSingleMetric('sso_client_auth_rate_limited_total')!.get();
  return values.find((v) => v.labels.scope === scope)!.value;
}

describe('ClientAuthenticationService global client cap (DEBT-072)', () => {
  let calls: string[];
  let known: boolean;
  let valid: boolean;
  const reserve = jest.fn<RateLimitService['reserve']>();
  const refund = jest.fn<RateLimitService['refund']>();
  const reserveGlobal = jest.fn<RateLimitService['reserveGlobal']>();
  const clientOk = jest.fn<RateLimitService['clientOk']>();
  const verifySecret = jest.fn<ClientCredentialService['verifySecret']>();
  const findByClientId = jest.fn<ClientService['findByClientId']>();
  let warn: jest.SpiedFunction<Logger['warn']>;

  const svc = new ClientAuthenticationService(
    { findByClientId } as unknown as ClientService,
    { verifySecret } as unknown as ClientCredentialService,
    { reserve, refund, reserveGlobal, clientOk } as unknown as RateLimitService,
    {
      getOrThrow: () => ({
        clientAuthFailIpMax: 30,
        clientAuthFailClientMax: 10,
        clientAuthFailGlobalMax: 100,
        clientAuthFailUnknownMax: 300,
      }),
    } as unknown as ConfigService,
  );
  const auth = () =>
    svc.authenticate(
      { clientId: CLIENT_ID, method: 'client_secret_basic', secret: 'pw' },
      { ip: IP },
    );

  beforeEach(() => {
    calls = [];
    known = true;
    valid = true;
    reserve.mockReset().mockImplementation(async () => {
      calls.push('reserve');
      return { blocked: false, retryAfterSec: 0 };
    });
    refund.mockReset().mockImplementation(async () => {
      calls.push('refund');
    });
    reserveGlobal.mockReset().mockImplementation(async () => {
      calls.push('global');
      return { blocked: false, retryAfterSec: 0, first: false, reserved: true };
    });
    clientOk.mockReset().mockImplementation(async () => {
      calls.push('clientOk');
    });
    verifySecret.mockReset().mockImplementation(async () => {
      calls.push('verify');
      return { valid } as Awaited<ReturnType<ClientCredentialService['verifySecret']>>;
    });
    findByClientId.mockReset().mockImplementation(async (id) => {
      calls.push('find');
      return known
        ? ({ clientId: id, tokenEndpointAuthMethod: 'client_secret_basic' } as Client)
        : null;
    });
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('order: per-IP reserve -> find -> global reserve -> Argon2; success refunds and trusts the source', async () => {
    await expect(auth()).resolves.toEqual(expect.objectContaining({ clientId: CLIENT_ID }));
    expect(calls).toEqual(['reserve', 'find', 'global', 'verify', 'refund', 'clientOk']);
    expect(reserveGlobal).toHaveBeenCalledWith(
      {
        gKey: `rl:client-auth-g:{${TAG}}`,
        okKey: `rl:client-auth-g:{${TAG}}:ok:${sha256(IP)}`,
        logKey: `rl:client-auth-g:{${TAG}}:logged`,
      },
      100,
    );
    expect(clientOk).toHaveBeenCalledWith(
      `rl:client-auth-g:{${TAG}}`,
      `rl:client-auth-g:{${TAG}}:ok:${sha256(IP)}`,
      true,
    );
  });

  it('exempt (trusted) source succeeds => trust refreshed but the global bucket is NOT given back (reserved=false)', async () => {
    reserveGlobal.mockResolvedValueOnce({
      blocked: false,
      retryAfterSec: 0,
      first: false,
      reserved: false,
    });
    await expect(auth()).resolves.toEqual(expect.objectContaining({ clientId: CLIENT_ID }));
    expect(clientOk).toHaveBeenCalledWith(
      `rl:client-auth-g:{${TAG}}`,
      `rl:client-auth-g:{${TAG}}:ok:${sha256(IP)}`,
      false,
    );
  });

  it('wrong secret => InvalidClientError, both reservations kept (no refund, no trust)', async () => {
    valid = false;
    await expect(auth()).rejects.toBeInstanceOf(InvalidClientError);
    expect(calls).toEqual(['reserve', 'find', 'global', 'verify']);
  });

  it('global cap blocks => no Argon2, per-IP refunded, 429 error scope client, counted, logged once (first)', async () => {
    reserveGlobal.mockImplementation(async () => {
      calls.push('global');
      return { blocked: true, retryAfterSec: 42, first: true, reserved: false };
    });
    const before = await limited('client');
    const err = await auth().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClientAuthRateLimitedError);
    expect(err).toEqual(expect.objectContaining({ retryAfterSec: 42, scope: 'client' }));
    expect(verifySecret).not.toHaveBeenCalled();
    expect(calls).toEqual(['reserve', 'find', 'global', 'refund']);
    expect(refund).toHaveBeenCalledWith(reserve.mock.calls[0]![0].map((b) => b.key));
    expect(await limited('client')).toBe(before + 1);
    expect(warn).toHaveBeenCalledWith({ clientId: CLIENT_ID }, 'client-auth global limit reached');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(IP);
  });

  it('global cap blocks again in the same window (first=false) => no log line', async () => {
    reserveGlobal.mockResolvedValue({
      blocked: true,
      retryAfterSec: 5,
      first: false,
      reserved: false,
    });
    await expect(auth()).rejects.toBeInstanceOf(ClientAuthRateLimitedError);
    expect(warn).not.toHaveBeenCalled();
  });

  it('unknown client_id => the shared {unknown} bucket with the unknown limit (no key from the raw id), scope unknown_client', async () => {
    known = false;
    reserveGlobal.mockResolvedValueOnce({
      blocked: false,
      retryAfterSec: 0,
      first: false,
      reserved: true,
    });
    await expect(auth()).rejects.toBeInstanceOf(InvalidClientError);
    const [keys, limit] = reserveGlobal.mock.calls[0]!;
    expect(keys.gKey).toBe('rl:client-auth-g:{unknown}');
    expect(keys.logKey).toBe('rl:client-auth-g:{unknown}:logged');
    expect(keys.okKey.startsWith('rl:client-auth-g:{unknown}:')).toBe(true);
    expect(JSON.stringify(keys)).not.toContain(CLIENT_ID);
    expect(JSON.stringify(keys)).not.toContain(TAG);
    expect(limit).toBe(300);
    expect(verifySecret).toHaveBeenCalledTimes(1); // Argon2 still runs (timing equalised)

    reserveGlobal.mockResolvedValueOnce({
      blocked: true,
      retryAfterSec: 9,
      first: true,
      reserved: false,
    });
    const before = await limited('unknown_client');
    await expect(auth()).rejects.toEqual(expect.objectContaining({ scope: 'unknown_client' }));
    expect(await limited('unknown_client')).toBe(before + 1);
    expect(warn).toHaveBeenCalledWith(
      { clientId: '(unknown)' },
      'client-auth global limit reached',
    );
  });

  it('per-IP bucket blocks => scope source, counted, nothing else touched', async () => {
    reserve.mockResolvedValueOnce({ blocked: true, retryAfterSec: 7 });
    const before = await limited('source');
    await expect(auth()).rejects.toEqual(expect.objectContaining({ scope: 'source' }));
    expect(await limited('source')).toBe(before + 1);
    expect(findByClientId).not.toHaveBeenCalled();
    expect(reserveGlobal).not.toHaveBeenCalled();
  });

  it('Redis error on the global reserve propagates (fail-closed): no Argon2, no refund', async () => {
    reserveGlobal.mockRejectedValueOnce(new Error('redis down'));
    await expect(auth()).rejects.toThrow('redis down');
    expect(verifySecret).not.toHaveBeenCalled();
    expect(refund).not.toHaveBeenCalled();
  });

  it('clientOk failure after a valid secret => still authenticated, warn only', async () => {
    clientOk.mockRejectedValueOnce(new Error('redis down'));
    await expect(auth()).resolves.toEqual(expect.objectContaining({ clientId: CLIENT_ID }));
    expect(warn).toHaveBeenCalled();
  });

  it('method none never touches either limiter', async () => {
    findByClientId.mockResolvedValueOnce({
      clientId: CLIENT_ID,
      tokenEndpointAuthMethod: 'none',
    } as Client);
    await svc.authenticate({ clientId: CLIENT_ID, method: 'none' }, { ip: IP });
    expect(reserve).not.toHaveBeenCalled();
    expect(reserveGlobal).not.toHaveBeenCalled();
    expect(clientOk).not.toHaveBeenCalled();
  });
});
