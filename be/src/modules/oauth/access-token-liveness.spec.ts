import { jest } from '@jest/globals';
import { Types } from 'mongoose';
import {
  isAccessTokenLive,
  type ClientLookup,
  type ResourceLookup,
  type SessionEndLookup,
  type UserExistence,
} from './access-token-liveness';
import { CLIENT_DISABLE_MARGIN_MS, mintedBeforeDisable } from '../clients/client.service';

/**
 * Task 0 unit coverage for the resourceId↔identifier mapping in `isAccessTokenLive` (spec §7).
 * `aud` is a URI (a `Resource.identifier`); `client.allowedResources[]` holds resourceIds. Liveness
 * must compare `aud` against the IDENTIFIERS of the client's allowed resourceIds — never the URI to
 * a resourceId directly — and fail CLOSED (propagate) when the resource lookup errors.
 */
describe('isAccessTokenLive — resource mapping (Task 0)', () => {
  const SUB = new Types.ObjectId().toHexString();
  const AUD = 'https://api.example.com/';
  const claims = { sub: SUB, client_id: 'client-a', aud: AUD, iat: 1 };

  const ADMIN_AUD = 'https://idp.example.com/admin/';
  const liveClient: ClientLookup = {
    findByClientId: async () => ({
      allowedResources: ['res-api'],
      clientType: 'confidential',
      tokenEndpointAuthMethod: 'client_secret_basic',
    }),
  };
  const users: UserExistence = { exists: async () => true };
  const sessions: SessionEndLookup = { isEnded: async () => false };

  it('live when aud is the identifier of an allowed resourceId', async () => {
    const resources: ResourceLookup = { identifiersFor: async () => [AUD] };
    expect(await isAccessTokenLive(claims, liveClient, users, sessions, resources, ADMIN_AUD)).toBe(
      true,
    );
  });

  it('NOT live when aud is not among the allowed resources identifiers (cross-resource IDOR)', async () => {
    const resources: ResourceLookup = {
      identifiersFor: async () => ['https://other.example.com/'],
    };
    expect(await isAccessTokenLive(claims, liveClient, users, sessions, resources, ADMIN_AUD)).toBe(
      false,
    );
  });

  it('NOT live when allowedResources contains the URI itself (confused deputy: id != URI)', async () => {
    // A client that mistakenly stores the URI as a "resourceId": `identifiersFor` finds no Resource
    // whose resourceId equals the URI, so it returns [] and the token is rejected (fail-closed).
    const resources: ResourceLookup = { identifiersFor: async () => [] };
    const client: ClientLookup = {
      findByClientId: async () => ({
        allowedResources: [AUD],
        clientType: 'confidential',
        tokenEndpointAuthMethod: 'client_secret_basic',
      }),
    };
    expect(await isAccessTokenLive(claims, client, users, sessions, resources, ADMIN_AUD)).toBe(
      false,
    );
  });

  it('(e) fail-closed: a resource-lookup error PROPAGATES (never swallowed into true/false)', async () => {
    const boom = new Error('mongo down');
    const resources: ResourceLookup = {
      identifiersFor: jest.fn<ResourceLookup['identifiersFor']>().mockRejectedValue(boom),
    };
    await expect(
      isAccessTokenLive(claims, liveClient, users, sessions, resources, ADMIN_AUD),
    ).rejects.toThrow('mongo down');
  });

  it('does not resolve the user when the aud mapping already rejects', async () => {
    const exists = jest.fn<UserExistence['exists']>().mockResolvedValue(true);
    const resources: ResourceLookup = {
      identifiersFor: async () => ['https://other.example.com/'],
    };
    const live = await isAccessTokenLive(
      claims,
      liveClient,
      { exists },
      sessions,
      resources,
      ADMIN_AUD,
    );
    expect(live).toBe(false);
    expect(exists).not.toHaveBeenCalled();
  });
});

/**
 * DEBT-177: an `aud=admin` access token is live only while its client is STILL admin-capable
 * (same predicate as issuance and `AdminTokenGuard`, DEBT-174). Any other `aud` is unaffected.
 */
describe('isAccessTokenLive — admin-capable client invariant (DEBT-177)', () => {
  const SUB = new Types.ObjectId().toHexString();
  const ADMIN_AUD = 'https://idp.example.com/admin/';
  const API_AUD = 'https://api.example.com/';
  const users: UserExistence = { exists: async () => true };
  const sessions: SessionEndLookup = { isEnded: async () => false };
  const resources: ResourceLookup = { identifiersFor: async () => [ADMIN_AUD, API_AUD] };

  const shapes: Array<[string, Record<string, unknown>, boolean]> = [
    ['{public, none}', { clientType: 'public', tokenEndpointAuthMethod: 'none' }, false],
    [
      '{confidential, none}',
      { clientType: 'confidential', tokenEndpointAuthMethod: 'none' },
      false,
    ],
    [
      '{confidential, client_secret_basic}',
      { clientType: 'confidential', tokenEndpointAuthMethod: 'client_secret_basic' },
      true,
    ],
    [
      '{confidential, client_secret_post}',
      { clientType: 'confidential', tokenEndpointAuthMethod: 'client_secret_post' },
      true,
    ],
    ['clientType missing', { tokenEndpointAuthMethod: 'client_secret_basic' }, false],
    ['auth method missing', { clientType: 'confidential' }, false],
    [
      'unknown clientType',
      { clientType: 'Confidential', tokenEndpointAuthMethod: 'client_secret_basic' },
      false,
    ],
    [
      'unknown auth method',
      { clientType: 'confidential', tokenEndpointAuthMethod: 'private_key_jwt' },
      false,
    ],
  ];

  const lookup = (shape: Record<string, unknown>): ClientLookup => ({
    findByClientId: async () =>
      ({ allowedResources: ['admin', 'api'], ...shape }) as Awaited<
        ReturnType<ClientLookup['findByClientId']>
      >,
  });

  it.each(shapes)('aud=admin, client %s => live only if admin-capable', async (_n, shape, ok) => {
    const exists = jest.fn<UserExistence['exists']>().mockResolvedValue(true);
    const claims = { sub: SUB, client_id: 'c', aud: ADMIN_AUD, iat: 1 };
    expect(
      await isAccessTokenLive(claims, lookup(shape), { exists }, sessions, resources, ADMIN_AUD),
    ).toBe(ok);
    // Refused before the user lookup (no needless DB work for a dead token).
    if (!ok) expect(exists).not.toHaveBeenCalled();
  });

  it.each(shapes)('ordinary aud, client %s => unaffected (still live)', async (_n, shape) => {
    const claims = { sub: SUB, client_id: 'c', aud: API_AUD, iat: 1 };
    expect(
      await isAccessTokenLive(claims, lookup(shape), users, sessions, resources, ADMIN_AUD),
    ).toBe(true);
  });

  it('a client-lookup error propagates (fail-closed, never false/true)', async () => {
    const clients: ClientLookup = {
      findByClientId: jest
        .fn<ClientLookup['findByClientId']>()
        .mockRejectedValue(new Error('mongo down')),
    };
    const claims = { sub: SUB, client_id: 'c', aud: ADMIN_AUD, iat: 1 };
    await expect(
      isAccessTokenLive(claims, clients, users, sessions, resources, ADMIN_AUD),
    ).rejects.toThrow('mongo down');
  });
});

/** DEBT-209/156: an access token issued at or before the client's last disable (+ margin) is dead. */
describe('isAccessTokenLive / mintedBeforeDisable — last disable epoch (DEBT-209)', () => {
  const SUB = new Types.ObjectId().toHexString();
  const AUD = 'https://api.example.com/';
  const users: UserExistence = { exists: async () => true };
  const sessions: SessionEndLookup = { isEnded: async () => false };
  const resources: ResourceLookup = { identifiersFor: async () => [AUD] };
  const DISABLED = new Date('2026-10-26T10:00:00.000Z');
  const client = (lastDisabledAt?: Date): ClientLookup => ({
    findByClientId: async () => ({
      allowedResources: ['res-api'],
      clientType: 'confidential',
      tokenEndpointAuthMethod: 'client_secret_basic',
      ...(lastDisabledAt ? { lastDisabledAt } : {}),
    }),
  });
  const live = (iatMs: number, lastDisabledAt?: Date) =>
    isAccessTokenLive(
      { sub: SUB, client_id: 'c', aud: AUD, iat: Math.floor(iatMs / 1000) },
      client(lastDisabledAt),
      users,
      sessions,
      resources,
      'https://idp.example.com/admin/',
    );

  it('pure predicate: <= lastDisabledAt + margin => true; after => false; never disabled => false', () => {
    const t = DISABLED.getTime();
    expect(mintedBeforeDisable({ lastDisabledAt: DISABLED }, t - 60_000)).toBe(true);
    expect(mintedBeforeDisable({ lastDisabledAt: DISABLED }, t + CLIENT_DISABLE_MARGIN_MS)).toBe(
      true,
    );
    expect(
      mintedBeforeDisable({ lastDisabledAt: DISABLED }, t + CLIENT_DISABLE_MARGIN_MS + 1),
    ).toBe(false);
    expect(mintedBeforeDisable({}, 0)).toBe(false);
    expect(mintedBeforeDisable({ lastDisabledAt: null }, 0)).toBe(false);
    expect(CLIENT_DISABLE_MARGIN_MS).toBe(5_000);
  });

  it('AT issued before the disable => not live; issued after disable + margin => live; no epoch => live', async () => {
    const t = DISABLED.getTime();
    expect(await live(t - 60_000, DISABLED)).toBe(false);
    expect(await live(t + 4_000, DISABLED)).toBe(false); // in-flight inside the margin
    expect(await live(t + 6_000, DISABLED)).toBe(true);
    expect(await live(t - 60_000)).toBe(true);
  });
});
