import mongoose, { type Connection, type Model } from 'mongoose';
import { validateEnv } from '../config/validation.schema';
import { MODELS } from './mongo/models';
import { DEFAULT_TENANT_ID } from '../modules/identity/tenant.service';
import type { Client } from '../modules/clients/client.service';
import type { Resource } from '../modules/resources/resource.service';
import { validateRedirectUriList } from '../modules/clients/redirect-uri.validator';
import { validateResourceFormat } from '../modules/resources/resource.validator';

/**
 * Dev-only provisioning CLI (Task 4, interim for B6.4; DEBT-077).
 *
 * Seeds the minimum control-plane records so the `fe-sso-test` SPA (public client, PKCE) can run
 * the full `/authorize` -> `/token` flow against a local IdP (X1 walking skeleton, run 22):
 *   - a public client `fe-sso-test` (`token_endpoint_auth_method=none`, NO secret);
 *   - a `demo` resource whose `identifier` is `${issuer}/demo/` (= `VITE_OIDC_RESOURCE`).
 *
 * NOT hooked to app boot and NOT run inside integration tests (it would pollute the shared
 * int-test DB the CORS suite depends on) -- it is an explicit opt-in script (`pnpm db:seed-dev`),
 * same shape as `sync-indexes.ts`.
 *
 * Idempotent: every write is an upsert keyed by a stable key (`clientId` for the client,
 * `resourceId` for the resource), so running it twice — or after `ISSUER` changes — converges to
 * one client + one resource and never duplicates. The resource is keyed by `resourceId` (not
 * `identifier`) precisely so that changing `ISSUER` (which changes `identifier`) updates the one
 * `demo` resource in place instead of inserting a second document. A concurrent upsert that loses
 * the unique-index race (E11000) is treated as success, exactly like `TenantService.seedDefault`.
 * DEBT-077/B6.4: `Resource.resourceId` has no unique index, so this dev-only CLI relies on the
 * `identifier` unique index plus sequential single-process runs for concurrency safety; the proper
 * fix (control-plane provisioning API, run 22+) replaces this script.
 *
 * Fail-closed on environment: `seedDev` throws with `NODE_ENV=production` BEFORE any DB write, and
 * the CLI additionally refuses BEFORE opening a DB connection, so a production database can never
 * be written by this dev tool.
 */

const CLIENT_ID = 'fe-sso-test';
const RESOURCE_ID = 'demo';

export interface SeedDevTargets {
  client: Omit<Client, 'frontchannelLogoutUri'>;
  resource: Resource;
}

/** Build the target config from the issuer. `identifier` = `${issuer without trailing /}/demo/`. */
export function buildSeedDevTargets(issuer: string): SeedDevTargets {
  const base = issuer.replace(/\/+$/, '');
  return {
    client: {
      clientId: CLIENT_ID,
      clientType: 'public',
      tokenEndpointAuthMethod: 'none',
      grantTypes: ['authorization_code', 'refresh_token'],
      redirectUris: ['http://localhost:5173/callback'],
      postLogoutRedirectUris: ['http://localhost:5173/'],
      allowedCorsOrigins: ['http://localhost:5173'],
      allowedResources: [RESOURCE_ID],
      scopes: ['openid', 'profile', 'email', 'offline_access'],
      tenantId: DEFAULT_TENANT_ID,
    },
    resource: {
      resourceId: RESOURCE_ID,
      identifier: `${base}/demo/`,
      scopes: [],
    },
  };
}

/**
 * Upsert the `fe-sso-test` client + `demo` resource on the given connection. Dev-only and
 * fail-closed: `seedDev` itself refuses `NODE_ENV=production` BEFORE any DB write, so no caller
 * (CLI, test, or future import) can write a production database even if it forgets to guard first.
 * URIs/identifier are format-validated the same way `ClientService.create`/`ResourceService.create`
 * validate them (INV-4/INV-14) with `allowHttpLocalhost` on (never used in production). No
 * `ClientCredential` is created: the client is public and has no secret.
 */
export async function seedDev(
  connection: Connection,
  issuer: string,
  nodeEnv: string | undefined,
): Promise<void> {
  // Fail-closed BEFORE any write: this dev tool must never mutate a production database, even if a
  // caller reaches `seedDev` without having guarded first.
  assertNotProduction(nodeEnv);

  const { client, resource } = buildSeedDevTargets(issuer);

  validateRedirectUriList(client.redirectUris, { allowHttpLocalhost: true });
  validateRedirectUriList(client.postLogoutRedirectUris, { allowHttpLocalhost: true });
  validateResourceFormat(resource.identifier);

  const clientModel: Model<Client> = connection.models.Client ?? connection.model<Client>('Client');
  const resourceModel: Model<Resource> =
    connection.models.Resource ?? connection.model<Resource>('Resource');

  await upsert(() =>
    clientModel.updateOne({ clientId: client.clientId }, { $set: client }, { upsert: true }).exec(),
  );
  console.log(`seed-dev: upserted client ${client.clientId}`);

  // Key the resource upsert by the stable `resourceId` (never `identifier`): `identifier` is
  // derived from `ISSUER`, so keying by it would insert a second `demo` document every time the
  // issuer changes. Keying by `resourceId` updates the single `demo` resource in place.
  await upsert(() =>
    resourceModel
      .updateOne({ resourceId: resource.resourceId }, { $set: resource }, { upsert: true })
      .exec(),
  );
  console.log(`seed-dev: upserted resource ${resource.resourceId}`);
}

/**
 * Fail-closed environment guard. Throws when `NODE_ENV=production` so the dev seed can never
 * write a production database. Called by the CLI BEFORE any DB connection is opened.
 */
export function assertNotProduction(nodeEnv: string | undefined): void {
  if (nodeEnv === 'production') {
    throw new Error('seed-dev: refusing to run with NODE_ENV=production');
  }
}

/** Run an upsert, swallowing only the E11000 a lost concurrent-insert race produces. */
async function upsert(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
  }
}

async function main(): Promise<void> {
  // Fail-closed BEFORE any DB connection: this tool must never touch a production database.
  assertNotProduction(process.env.NODE_ENV);

  const env = validateEnv(process.env);
  const connection = await mongoose
    .createConnection(env.MONGO_URI, { autoIndex: false, serverSelectionTimeoutMS: 5000 })
    .asPromise();
  // Register schemas so index/validation behave like the running app.
  for (const { name, schema } of MODELS) {
    if (!connection.models[name]) connection.model(name, schema);
  }
  try {
    await seedDev(connection, env.ISSUER, process.env.NODE_ENV);
  } finally {
    await connection.close();
  }
}

// `require` is undefined when imported under ESM (Jest); the built CLI is CJS.
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((err: Error) => {
    console.error(`seed-dev failed: ${err.message}`);
    process.exit(1);
  });
}
