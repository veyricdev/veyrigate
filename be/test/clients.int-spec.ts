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
    ...overrides,
  };
  return { getOrThrow: (ns: string) => base[ns] } as unknown as ConfigService;
}

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
    clientAuth = new ClientAuthenticationService(clients, credentials);
    resources = new ResourceService(resourceModel);
    cors = new ClientCorsService(clientModel);
  }

  beforeAll(async () => {
    connection = await mongoose
      .createConnection(MONGO_URI, { autoIndex: false })
      .asPromise();
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
      await expect(resources.resolveForClient(['res-game-a'], 'https://x.example.com/#f')).rejects.toBeInstanceOf(
        InvalidResourceError,
      );
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
      const client = await clientAuth.authenticate({
        clientId: 'confidential-basic',
        method: 'client_secret_basic',
        secret,
      });
      expect(client.clientId).toBe('confidential-basic');
    });

    it('wrong secret → InvalidClientError', async () => {
      await expect(
        clientAuth.authenticate({
          clientId: 'confidential-basic',
          method: 'client_secret_basic',
          secret: 'totally-wrong',
        }),
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
        clientAuth.authenticate({
          clientId: 'confidential-basic-2',
          method: 'client_secret_post',
          secret,
        }),
      ).rejects.toBeInstanceOf(InvalidClientError);
    });

    it('unknown client_id → InvalidClientError (does not throw/leak a different error)', async () => {
      await expect(
        clientAuth.authenticate({
          clientId: 'does-not-exist',
          method: 'client_secret_basic',
          secret: 'anything',
        }),
      ).rejects.toBeInstanceOf(InvalidClientError);
    });

    it('public client (none) authenticates without a secret', async () => {
      const client = await clientAuth.authenticate({ clientId: 'public-none', method: 'none' });
      expect(client.clientId).toBe('public-none');
    });

    it('public client cannot authenticate via client_secret_post even with a guessed value', async () => {
      await expect(
        clientAuth.authenticate({
          clientId: 'public-none',
          method: 'client_secret_post',
          secret: 'whatever',
        }),
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
        clientAuth.authenticate({
          clientId: 'rotating-client',
          method: 'client_secret_basic',
          secret: first.secret,
        }),
      ).resolves.toMatchObject({ clientId: 'rotating-client' });

      await expect(
        clientAuth.authenticate({
          clientId: 'rotating-client',
          method: 'client_secret_basic',
          secret: rotated.secret,
        }),
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
        clientAuth.authenticate({
          clientId: 'revoke-client',
          method: 'client_secret_basic',
          secret: issued.secret,
        }),
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
        clientAuth.authenticate({
          clientId: 'confidential-basic',
          method: 'client_secret_basic',
          secret,
        }),
      ).rejects.toBeInstanceOf(InvalidClientError);
    });

    // Tester risk matrix — State: concurrent. Documents DEBT-021 (senior review): rotateSecret
    // computes nextVersion from a snapshot read, no unique index on (clientId, version) → two
    // concurrent rotations on the same client can race. Not a security bypass (verifySecret
    // matches by secret hash per-document, not by version), but it does mean version numbers can
    // collide. This test asserts the behaviour actually observed today; if/when DEBT-021 is fixed
    // (e.g. a unique index forcing one call to fail), this test's second expectation should be
    // updated to assert exactly one rejection instead.
    it('two concurrent rotateSecret calls on the same client can both succeed with a duplicate version (DEBT-021, not a security bypass)', async () => {
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

      // Both calls succeed (no atomic guard today) and each issued secret still authenticates —
      // no cross-contamination between the two concurrently-issued secrets.
      await expect(
        clientAuth.authenticate({
          clientId: 'rotating-concurrent',
          method: 'client_secret_basic',
          secret: a.secret,
        }),
      ).resolves.toMatchObject({ clientId: 'rotating-concurrent' });
      await expect(
        clientAuth.authenticate({
          clientId: 'rotating-concurrent',
          method: 'client_secret_basic',
          secret: b.secret,
        }),
      ).resolves.toMatchObject({ clientId: 'rotating-concurrent' });
    });
  });

  describe('B3.4 — dynamic CORS origin resolution (D8, §9.7)', () => {
    beforeAll(async () => {
      await clients.create({
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
});
