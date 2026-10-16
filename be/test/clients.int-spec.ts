import { jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import mongoose, { type Connection, type Model } from 'mongoose';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import {
  ClientAuthenticationService,
  InvalidClientError,
} from '../src/modules/clients/client-authentication.service';
import {
  ClientCredentialService,
  type ClientCredential,
} from '../src/modules/clients/client-credential.service';
import { ClientCorsService } from '../src/modules/clients/client-cors.service';
import { ClientService, type Client } from '../src/modules/clients/client.service';
import { InvalidRedirectUriError } from '../src/modules/clients/redirect-uri.validator';
import type { RateLimitService } from '../src/modules/security/rate-limit/rate-limit.service';
import { DuplicateError } from '../src/modules/identity/identity.errors';
import { InvalidResourceError } from '../src/modules/resources/resource.validator';
import { ResourceService, type Resource } from '../src/modules/resources/resource.service';

const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-clients-${Date.now()}?directConnection=true`;

function config(overrides: Record<string, unknown> = {}): ConfigService {
  const base: Record<string, unknown> = {
    app: { nodeEnv: 'production', issuer: 'http://localhost:4000' },
    client: { secretGraceTtl: 3600 },
    // High thresholds so the client-auth failure limiter never fires in these unit-style tests.
    security: { clientAuthFailIpMax: 10000, clientAuthFailClientMax: 10000 },
    ...overrides,
  };
  return { getOrThrow: (ns: string) => base[ns] } as unknown as ConfigService;
}

/** A no-op rate limiter: reserve never blocks, refund is a no-op (no Redis in these tests). */
const noRateLimit = {
  reserve: async () => ({ blocked: false, retryAfterSec: 0 }),
  refund: async () => undefined,
} as unknown as RateLimitService;

describe('Clients + Resources on real Mongo (B3.1–B3.3)', () => {
  let connection: Connection;
  let clientModel: Model<Client>;
  let credentialModel: Model<ClientCredential>;
  let resourceModel: Model<Resource>;
  let clients: ClientService;
  let credentials: ClientCredentialService;
  let clientAuth: ClientAuthenticationService;
  let resources: ResourceService;
  let cors: ClientCorsService;

  function build(cfg: ConfigService): void {
    clients = new ClientService(clientModel, cfg);
    credentials = new ClientCredentialService(credentialModel, cfg);
    clientAuth = new ClientAuthenticationService(clients, credentials, noRateLimit, cfg);
    resources = new ResourceService(resourceModel);
    cors = new ClientCorsService(clientModel);
  }

  beforeAll(async () => {
    connection = await mongoose.createConnection(MONGO_URI, { autoIndex: false }).asPromise();
    for (const { name, schema } of MODELS) connection.model(name, schema);
    await syncAllIndexes(connection);
    clientModel = connection.model<Client>('Client');
    credentialModel = connection.model<ClientCredential>('ClientCredential');
    resourceModel = connection.model<Resource>('Resource');
    build(config());
  }, 30_000);

  afterAll(async () => {
    await connection.dropDatabase();
    await connection.close();
  });

  describe('B3.1 — Client creation + redirect_uri validation', () => {
    it('creates a confidential client with valid https redirect/post-logout URIs', async () => {
      const c = await clients.create({
        clientId: 'client-a',
        clientType: 'confidential',
        tokenEndpointAuthMethod: 'client_secret_basic',
        redirectUris: ['https://app.example.com/callback'],
        postLogoutRedirectUris: ['https://app.example.com/logged-out'],
        tenantId: 'default-tenant',
      });
      expect(c.clientId).toBe('client-a');
      expect(await clients.findByClientId('client-a')).toMatchObject({ clientId: 'client-a' });
    });

    it('duplicate clientId → DuplicateError', async () => {
      await expect(
        clients.create({
          clientId: 'client-a',
          clientType: 'confidential',
          tokenEndpointAuthMethod: 'client_secret_basic',
          tenantId: 'default-tenant',
        }),
      ).rejects.toBeInstanceOf(DuplicateError);
    });

    // Trailing-slash / extra-query variants are syntactically valid URIs on their own — they
    // are rejected at *match* time against a different registered URI (unit-tested in
    // redirect-uri.validator.spec.ts via isRegisteredRedirectUri), not at registration time.
    it.each([
      ['wildcard subdomain', 'https://*.example.com/callback'],
      ['wildcard path', 'https://app.example.com/*'],
      ['fragment', 'https://app.example.com/callback#frag'],
      ['non-https scheme', 'http://app.example.com/callback'],
    ])('rejects redirect_uri variant: %s (%s)', async (_label, uri) => {
      await expect(
        clients.create({
          clientId: `client-bad-${Buffer.from(uri).toString('hex').slice(0, 8)}`,
          clientType: 'confidential',
          tokenEndpointAuthMethod: 'client_secret_basic',
          redirectUris: [uri],
          tenantId: 'default-tenant',
        }),
      ).rejects.toBeInstanceOf(InvalidRedirectUriError);
    });

    it('http://localhost allowed outside production, rejected when NODE_ENV=production (tech-lead C1)', async () => {
      build(config({ app: { nodeEnv: 'production' } }));
      await expect(
        clients.create({
          clientId: 'client-dev-prod',
          clientType: 'public',
          tokenEndpointAuthMethod: 'none',
          redirectUris: ['http://localhost:5173/callback'],
          tenantId: 'default-tenant',
        }),
      ).rejects.toBeInstanceOf(InvalidRedirectUriError);

      build(config({ app: { nodeEnv: 'development' } }));
      const c = await clients.create({
        clientId: 'client-dev-dev',
        clientType: 'public',
        tokenEndpointAuthMethod: 'none',
        redirectUris: ['http://localhost:5173/callback'],
        tenantId: 'default-tenant',
      });
      expect(c.redirectUris).toEqual(['http://localhost:5173/callback']);
      build(config()); // reset for subsequent describe blocks (production, matches other suites)
    });

    it('accepts a valid https frontchannelLogoutUri at registration (B4.7)', async () => {
      const c = await clients.create({
        clientId: 'client-fc-ok',
        clientType: 'confidential',
        tokenEndpointAuthMethod: 'client_secret_basic',
        redirectUris: ['https://app.example.com/callback'],
        frontchannelLogoutUri: 'https://app.example.com/frontchannel',
        tenantId: 'default-tenant',
      });
      expect(c.frontchannelLogoutUri).toBe('https://app.example.com/frontchannel');
    });

    // frontchannelLogoutUri follows the same INV-4 format rule as redirect URIs, PLUS it rejects
    // hosts carrying CSP-breaking characters (`;`, `,`, whitespace) — that origin later builds a
    // `frame-src` allowlist, where those characters would inject/terminate a directive (B4.7).
    it.each([
      ['non-https in production', 'http://evil.example/fc'],
      ['wildcard path', 'https://app.example.com/*'],
      ['fragment', 'https://app.example.com/fc#f'],
      ['relative URI', '/frontchannel'],
      ['CSP-injecting host (semicolon)', 'https://a;b.example.com/fc'],
    ])('rejects frontchannelLogoutUri variant: %s (%s)', async (_label, uri) => {
      await expect(
        clients.create({
          clientId: `client-fc-bad-${Buffer.from(uri).toString('hex').slice(0, 8)}`,
          clientType: 'confidential',
          tokenEndpointAuthMethod: 'client_secret_basic',
          redirectUris: ['https://app.example.com/callback'],
          frontchannelLogoutUri: uri,
          tenantId: 'default-tenant',
        }),
      ).rejects.toBeInstanceOf(InvalidRedirectUriError);
    });
  });

  describe('B3.2 — Resources + allowedResources mapping (tech-lead C3)', () => {
    beforeAll(async () => {
      build(config());
      await resources.create({
        resourceId: 'res-game-a',
        identifier: 'https://api.game-a.example.com/',
        scopes: ['game_a.read'],
      });
      await clients.create({
        clientId: 'client-game',
        clientType: 'confidential',
        tokenEndpointAuthMethod: 'client_secret_basic',
        allowedResources: ['res-game-a'],
        tenantId: 'default-tenant',
      });
    });

    it('resolves an allowed resource URI to its Resource (by resourceId, not raw URI)', async () => {
      const resolved = await resources.resolveForClient(
        ['res-game-a'],
        'https://api.game-a.example.com/',
      );
      expect(resolved).toMatchObject({ resourceId: 'res-game-a' });
    });

    it('rejects a resource URI whose resourceId is not in allowedResources', async () => {
      await resources.create({
        resourceId: 'res-game-b',
        identifier: 'https://api.game-b.example.com/',
      });
      const resolved = await resources.resolveForClient(
        ['res-game-a'],
        'https://api.game-b.example.com/',
      );
      expect(resolved).toBeNull();
    });

    it('rejects an unregistered resource URI entirely', async () => {
      const resolved = await resources.resolveForClient(
        ['res-game-a'],
        'https://unregistered.example.com/',
      );
      expect(resolved).toBeNull();
    });

    it('rejects a resource with a fragment or non-absolute URI (format)', async () => {
      await expect(
        resources.resolveForClient(['res-game-a'], 'https://x.example.com/#f'),
      ).rejects.toBeInstanceOf(InvalidResourceError);
      await expect(resources.resolveForClient(['res-game-a'], 'not-a-uri')).rejects.toBeInstanceOf(
        InvalidResourceError,
      );
    });

    it('duplicate identifier → DuplicateError', async () => {
      await expect(
        resources.create({ resourceId: 'res-dup', identifier: 'https://api.game-a.example.com/' }),
      ).rejects.toBeInstanceOf(DuplicateError);
    });
  });

  describe('B3.3 — Client authentication for /token (tech-lead C4/C6)', () => {
    beforeAll(async () => {
      build(config({ client: { secretGraceTtl: 3600 } }));

      await clients.create({
        clientId: 'confidential-basic',
        clientType: 'confidential',
        tokenEndpointAuthMethod: 'client_secret_basic',
        tenantId: 'default-tenant',
      });
      await clients.create({
        clientId: 'public-none',
        clientType: 'public',
        tokenEndpointAuthMethod: 'none',
        tenantId: 'default-tenant',
      });
    });

    it('confidential client with correct secret authenticates', async () => {
      const { secret } = await credentials.createSecret('confidential-basic');
      const client = await clientAuth.authenticate(
        {
          clientId: 'confidential-basic',
          method: 'client_secret_basic',
          secret,
        },
        { ip: '127.0.0.1' },
      );
      expect(client.clientId).toBe('confidential-basic');
    });

    it('wrong secret → InvalidClientError', async () => {
      await expect(
        clientAuth.authenticate(
          {
            clientId: 'confidential-basic',
            method: 'client_secret_basic',
            secret: 'totally-wrong',
          },
          { ip: '127.0.0.1' },
        ),
      ).rejects.toBeInstanceOf(InvalidClientError);
    });

    it('method mismatch (client registered as basic, request uses post) → InvalidClientError', async () => {
      const { secret } = await credentials.createSecret('confidential-basic-2');
      await clients.create({
        clientId: 'confidential-basic-2',
        clientType: 'confidential',
        tokenEndpointAuthMethod: 'client_secret_basic',
        tenantId: 'default-tenant',
      });
      await expect(
        clientAuth.authenticate(
          {
            clientId: 'confidential-basic-2',
            method: 'client_secret_post',
            secret,
          },
          { ip: '127.0.0.1' },
        ),
      ).rejects.toBeInstanceOf(InvalidClientError);
    });

    it('unknown client_id → InvalidClientError (does not throw/leak a different error)', async () => {
      await expect(
        clientAuth.authenticate(
          {
            clientId: 'does-not-exist',
            method: 'client_secret_basic',
            secret: 'anything',
          },
          { ip: '127.0.0.1' },
        ),
      ).rejects.toBeInstanceOf(InvalidClientError);
    });

    it('public client (none) authenticates without a secret', async () => {
      const client = await clientAuth.authenticate(
        { clientId: 'public-none', method: 'none' },
        { ip: '127.0.0.1' },
      );
      expect(client.clientId).toBe('public-none');
    });

    it('public client cannot authenticate via client_secret_post even with a guessed value', async () => {
      await expect(
        clientAuth.authenticate(
          {
            clientId: 'public-none',
            method: 'client_secret_post',
            secret: 'whatever',
          },
          { ip: '127.0.0.1' },
        ),
      ).rejects.toBeInstanceOf(InvalidClientError);
    });

    it('rotation overlap: previous secret still authenticates during grace, new secret also works', async () => {
      await clients.create({
        clientId: 'rotating-client',
        clientType: 'confidential',
        tokenEndpointAuthMethod: 'client_secret_basic',
        tenantId: 'default-tenant',
      });
      const first = await credentials.createSecret('rotating-client');
      const rotated = await credentials.rotateSecret('rotating-client');
      expect(rotated.version).toBe(first.version + 1);

      await expect(
        clientAuth.authenticate(
          {
            clientId: 'rotating-client',
            method: 'client_secret_basic',
            secret: first.secret,
          },
          { ip: '127.0.0.1' },
        ),
      ).resolves.toMatchObject({ clientId: 'rotating-client' });

      await expect(
        clientAuth.authenticate(
          {
            clientId: 'rotating-client',
            method: 'client_secret_basic',
            secret: rotated.secret,
          },
          { ip: '127.0.0.1' },
        ),
      ).resolves.toMatchObject({ clientId: 'rotating-client' });
    });

    it('revoked secret can no longer authenticate even inside the grace window', async () => {
      await clients.create({
        clientId: 'revoke-client',
        clientType: 'confidential',
        tokenEndpointAuthMethod: 'client_secret_basic',
        tenantId: 'default-tenant',
      });
      const issued = await credentials.createSecret('revoke-client');
      await credentials.rotateSecret('revoke-client');
      const revoked = await credentials.revokeSecret('revoke-client', issued.version);
      expect(revoked).toBe(true);

      await expect(
        clientAuth.authenticate(
          {
            clientId: 'revoke-client',
            method: 'client_secret_basic',
            secret: issued.secret,
          },
          { ip: '127.0.0.1' },
        ),
      ).rejects.toBeInstanceOf(InvalidClientError);
    });

    it('secret of a different client never authenticates another client_id', async () => {
      await clients.create({
        clientId: 'other-client',
        clientType: 'confidential',
        tokenEndpointAuthMethod: 'client_secret_basic',
        tenantId: 'default-tenant',
      });
      const { secret } = await credentials.createSecret('other-client');
      await expect(
        clientAuth.authenticate(
          {
            clientId: 'confidential-basic',
            method: 'client_secret_basic',
            secret,
          },
          { ip: '127.0.0.1' },
        ),
      ).rejects.toBeInstanceOf(InvalidClientError);
    });

    // DEBT-021 (FIXED in run 20): the unique `(clientId, version)` index + E11000 retry makes two
    // concurrent rotations resolve with DIFFERENT versions (one retries after the other wins its
    // version). No duplicate doc, and each issued secret authenticates.
    it('two concurrent rotateSecret calls => two DIFFERENT versions, no duplicate, both authenticate (DEBT-021)', async () => {
      await clients.create({
        clientId: 'rotating-concurrent',
        clientType: 'confidential',
        tokenEndpointAuthMethod: 'client_secret_basic',
        tenantId: 'default-tenant',
      });
      await credentials.createSecret('rotating-concurrent');

      const [a, b] = await Promise.all([
        credentials.rotateSecret('rotating-concurrent'),
        credentials.rotateSecret('rotating-concurrent'),
      ]);

      // Distinct versions, and no two docs share a (clientId, version).
      expect(a.version).not.toBe(b.version);
      const docs = await credentialModel
        .find({ clientId: 'rotating-concurrent' })
        .lean<ClientCredential[]>();
      const versions = docs.map((d) => d.version);
      expect(new Set(versions).size).toBe(versions.length);

      await expect(
        clientAuth.authenticate(
          {
            clientId: 'rotating-concurrent',
            method: 'client_secret_basic',
            secret: a.secret,
          },
          { ip: '127.0.0.1' },
        ),
      ).resolves.toMatchObject({ clientId: 'rotating-concurrent' });
      await expect(
        clientAuth.authenticate(
          {
            clientId: 'rotating-concurrent',
            method: 'client_secret_basic',
            secret: b.secret,
          },
          { ip: '127.0.0.1' },
        ),
      ).resolves.toMatchObject({ clientId: 'rotating-concurrent' });
    });

    it('sequential: createSecret v1, rotate v2, revoke v2, rotate => v3 (not a reused v2) (DEBT-021)', async () => {
      await clients.create({
        clientId: 'seq-client',
        clientType: 'confidential',
        tokenEndpointAuthMethod: 'client_secret_basic',
        tenantId: 'default-tenant',
      });
      const v1 = await credentials.createSecret('seq-client');
      expect(v1.version).toBe(1);
      const v2 = await credentials.rotateSecret('seq-client');
      expect(v2.version).toBe(2);
      await credentials.revokeSecret('seq-client', 2);
      const v3 = await credentials.rotateSecret('seq-client');
      expect(v3.version).toBe(3); // NOT 2 again — version 2 is still reserved (revoked, not reused)
      expect(await credentialModel.countDocuments({ clientId: 'seq-client', version: 2 })).toBe(1);
    });

    it('expired latest version: rotate still computes max(all)+1 (DEBT-021)', async () => {
      await clients.create({
        clientId: 'exp-client',
        clientType: 'confidential',
        tokenEndpointAuthMethod: 'client_secret_basic',
        tenantId: 'default-tenant',
      });
      await credentials.createSecret('exp-client'); // v1
      const v2 = await credentials.rotateSecret('exp-client'); // v2
      // Force v2 to be already expired (so listActive would exclude it).
      await credentialModel.updateOne(
        { clientId: 'exp-client', version: v2.version },
        { $set: { expiresAt: new Date(Date.now() - 1000) } },
      );
      const v3 = await credentials.rotateSecret('exp-client');
      expect(v3.version).toBe(3); // max(all)+1, not max(active)+1 which would wrongly be 2
    });

    it('createSecret twice on the same client => v1, v2, both authenticate (DEBT-021)', async () => {
      await clients.create({
        clientId: 'twice-client',
        clientType: 'confidential',
        tokenEndpointAuthMethod: 'client_secret_basic',
        tenantId: 'default-tenant',
      });
      const first = await credentials.createSecret('twice-client');
      const second = await credentials.createSecret('twice-client');
      expect(first.version).toBe(1);
      expect(second.version).toBe(2);
      for (const issued of [first, second]) {
        await expect(
          clientAuth.authenticate(
            {
              clientId: 'twice-client',
              method: 'client_secret_basic',
              secret: issued.secret,
            },
            { ip: '127.0.0.1' },
          ),
        ).resolves.toMatchObject({ clientId: 'twice-client' });
      }
    });

    it('stale read => first insert E11000 => recomputes and retries ONCE => succeeds (DEBT-021, M11)', async () => {
      await clients.create({
        clientId: 'retry-client',
        clientType: 'confidential',
        tokenEndpointAuthMethod: 'client_secret_basic',
        tenantId: 'default-tenant',
      });
      const v1 = await credentials.createSecret('retry-client');
      expect(v1.version).toBe(1);

      // Force the FIRST version computation to read a stale max (version 0 => recompute v1), which
      // collides with the existing v1 => E11000. The retry uses the real findOne and gets v1 => v2.
      const model = credentialModel as unknown as { findOne: (...a: unknown[]) => unknown };
      const real = model.findOne.bind(credentialModel);
      const stale = {
        sort: () => stale,
        lean: () => stale,
        exec: async () => ({ version: 0 }),
      };
      const spy = jest.spyOn(model, 'findOne').mockImplementationOnce(() => stale as never);

      const v2 = await credentials.rotateSecret('retry-client');
      expect(v2.version).toBe(2); // the retry recomputed from the real max, not the stale 0
      expect(spy).toHaveBeenCalledTimes(2); // one stale read + one real retry read
      spy.mockRestore();
      void real;

      await expect(
        clientAuth.authenticate(
          { clientId: 'retry-client', method: 'client_secret_basic', secret: v2.secret },
          { ip: '127.0.0.1' },
        ),
      ).resolves.toMatchObject({ clientId: 'retry-client' });
    });

    it('two E11000 in a row => rethrows (no infinite loop) (DEBT-021, M11)', async () => {
      await clients.create({
        clientId: 'retry-twice-client',
        clientType: 'confidential',
        tokenEndpointAuthMethod: 'client_secret_basic',
        tenantId: 'default-tenant',
      });
      await credentials.createSecret('retry-twice-client'); // v1

      // Both version reads are stale (version 0 => recompute v1), colliding BOTH times with v1.
      const model = credentialModel as unknown as { findOne: (...a: unknown[]) => unknown };
      const stale = {
        sort: () => stale,
        lean: () => stale,
        exec: async () => ({ version: 0 }),
      };
      const spy = jest.spyOn(model, 'findOne').mockImplementation(() => stale as never);

      await expect(credentials.rotateSecret('retry-twice-client')).rejects.toMatchObject({
        code: 11000,
      });
      expect(spy).toHaveBeenCalledTimes(2); // retried exactly once, then rethrew (no loop)
      spy.mockRestore();
    });
  });

  describe('B3.4 — dynamic CORS origin resolution (D8, §9.7)', () => {
    beforeAll(async () => {
      // `http://localhost` origins are only valid outside production (B6.3a origin validator).
      const devClients = new ClientService(
        clientModel,
        config({ app: { nodeEnv: 'development', issuer: 'http://localhost:4000' } }),
      );
      await devClients.create({
        clientId: 'cors-spa',
        clientType: 'public',
        tokenEndpointAuthMethod: 'none',
        allowedCorsOrigins: ['https://app.example.com', 'http://localhost:5173'],
        tenantId: 'default-tenant',
      });
      await clients.create({
        clientId: 'cors-other',
        clientType: 'public',
        tokenEndpointAuthMethod: 'none',
        allowedCorsOrigins: ['https://other.example.com'],
        tenantId: 'default-tenant',
      });
    });

    it('allows a registered origin for its own client', async () => {
      expect(await cors.isOriginAllowedForClient('cors-spa', 'https://app.example.com')).toBe(true);
    });

    it('rejects an origin not registered for that client (even if another client has it)', async () => {
      expect(await cors.isOriginAllowedForClient('cors-spa', 'https://other.example.com')).toBe(
        false,
      );
    });

    it('rejects an unknown origin and an unknown client', async () => {
      expect(await cors.isOriginAllowedForClient('cors-spa', 'https://evil.example.com')).toBe(
        false,
      );
      expect(await cors.isOriginAllowedForClient('no-such-client', 'https://app.example.com')).toBe(
        false,
      );
    });

    it('rejects an empty origin', async () => {
      expect(await cors.isOriginAllowedForClient('cors-spa', '')).toBe(false);
      expect(await cors.isOriginRegisteredForAnyClient('')).toBe(false);
    });

    it('matches exact origin only — a trailing slash or different port is not a match', async () => {
      expect(await cors.isOriginAllowedForClient('cors-spa', 'https://app.example.com/')).toBe(
        false,
      );
      expect(await cors.isOriginAllowedForClient('cors-spa', 'http://localhost:4173')).toBe(false);
    });

    it('union allowlist accepts an origin registered by any client (jwks/discovery/preflight)', async () => {
      expect(await cors.isOriginRegisteredForAnyClient('https://app.example.com')).toBe(true);
      expect(await cors.isOriginRegisteredForAnyClient('https://other.example.com')).toBe(true);
    });

    it('union allowlist rejects an origin registered by no client', async () => {
      expect(await cors.isOriginRegisteredForAnyClient('https://evil.example.com')).toBe(false);
    });
  });

  describe('B4.4 Task 1 — grantTypes field (Q4/D7)', () => {
    it('new client defaults to grantTypes === [authorization_code]', async () => {
      const client = await clients.create({
        clientId: 'gt-default',
        clientType: 'public',
        tokenEndpointAuthMethod: 'none',
        redirectUris: ['https://app.example.com/callback'],
        tenantId: 'tenant-A',
      });
      expect(client.grantTypes).toEqual(['authorization_code']);
      const read = await clients.findByClientId('gt-default');
      expect(read?.grantTypes).toEqual(['authorization_code']);
    });

    it('stores and reads back an explicit [authorization_code, refresh_token]', async () => {
      await clients.create({
        clientId: 'gt-refresh',
        clientType: 'confidential',
        tokenEndpointAuthMethod: 'client_secret_basic',
        redirectUris: ['https://app.example.com/callback'],
        grantTypes: ['authorization_code', 'refresh_token'],
        tenantId: 'tenant-A',
      });
      const read = await clients.findByClientId('gt-refresh');
      expect(read?.grantTypes).toEqual(['authorization_code', 'refresh_token']);
    });

    it('a legacy doc written without grantTypes reads back [authorization_code] (lean normalise)', async () => {
      // Insert a raw document (bypasses Mongoose defaults, like a pre-B4.4 client).
      await clientModel.collection.insertOne({
        clientId: 'gt-legacy',
        clientType: 'public',
        tokenEndpointAuthMethod: 'none',
        redirectUris: [],
        postLogoutRedirectUris: [],
        allowedCorsOrigins: [],
        allowedResources: [],
        scopes: [],
        tenantId: 'tenant-A',
      });
      const read = await clients.findByClientId('gt-legacy');
      expect(read?.grantTypes).toEqual(['authorization_code']);
    });

    it('rejects an unknown grant value at write time (schema enum)', async () => {
      await expect(
        clientModel.collection
          .insertOne({ clientId: 'gt-bad', clientType: 'public', tenantId: 'tenant-A' })
          .then(() =>
            clientModel.validate({
              clientId: 'gt-bad2',
              clientType: 'public',
              tokenEndpointAuthMethod: 'none',
              grantTypes: ['password'],
              tenantId: 'tenant-A',
            }),
          ),
      ).rejects.toBeTruthy();
    });
  });
});
