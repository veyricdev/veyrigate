import { jest } from '@jest/globals';
import { Types } from 'mongoose';
import {
  isAccessTokenLive,
  type ClientLookup,
  type ResourceLookup,
  type SessionEndLookup,
  type UserExistence,
} from './access-token-liveness';

/**
 * Task 0 unit coverage for the resourceId↔identifier mapping in `isAccessTokenLive` (spec §7).
 * `aud` is a URI (a `Resource.identifier`); `client.allowedResources[]` holds resourceIds. Liveness
 * must compare `aud` against the IDENTIFIERS of the client's allowed resourceIds — never the URI to
 * a resourceId directly — and fail CLOSED (propagate) when the resource lookup errors.
 */
describe('isAccessTokenLive — resource mapping (Task 0)', () => {
  const SUB = new Types.ObjectId().toHexString();
  const AUD = 'https://api.example.com/';
  const claims = { sub: SUB, client_id: 'client-a', aud: AUD };

  const liveClient: ClientLookup = {
    findByClientId: async () => ({ allowedResources: ['res-api'] }),
  };
  const users: UserExistence = { exists: async () => true };
  const sessions: SessionEndLookup = { isEnded: async () => false };

  it('live when aud is the identifier of an allowed resourceId', async () => {
    const resources: ResourceLookup = { identifiersFor: async () => [AUD] };
    expect(await isAccessTokenLive(claims, liveClient, users, sessions, resources)).toBe(true);
  });

  it('NOT live when aud is not among the allowed resources identifiers (cross-resource IDOR)', async () => {
    const resources: ResourceLookup = {
      identifiersFor: async () => ['https://other.example.com/'],
    };
    expect(await isAccessTokenLive(claims, liveClient, users, sessions, resources)).toBe(false);
  });

  it('NOT live when allowedResources contains the URI itself (confused deputy: id != URI)', async () => {
    // A client that mistakenly stores the URI as a "resourceId": `identifiersFor` finds no Resource
    // whose resourceId equals the URI, so it returns [] and the token is rejected (fail-closed).
    const resources: ResourceLookup = { identifiersFor: async () => [] };
    const client: ClientLookup = { findByClientId: async () => ({ allowedResources: [AUD] }) };
    expect(await isAccessTokenLive(claims, client, users, sessions, resources)).toBe(false);
  });

  it('(e) fail-closed: a resource-lookup error PROPAGATES (never swallowed into true/false)', async () => {
    const boom = new Error('mongo down');
    const resources: ResourceLookup = {
      identifiersFor: jest.fn<ResourceLookup['identifiersFor']>().mockRejectedValue(boom),
    };
    await expect(isAccessTokenLive(claims, liveClient, users, sessions, resources)).rejects.toThrow(
      'mongo down',
    );
  });

  it('does not resolve the user when the aud mapping already rejects', async () => {
    const exists = jest.fn<UserExistence['exists']>().mockResolvedValue(true);
    const resources: ResourceLookup = {
      identifiersFor: async () => ['https://other.example.com/'],
    };
    const live = await isAccessTokenLive(claims, liveClient, { exists }, sessions, resources);
    expect(live).toBe(false);
    expect(exists).not.toHaveBeenCalled();
  });
});
