import { Types } from 'mongoose';
import mongoose, { type Connection, type Model } from 'mongoose';
import { z } from 'zod';
import { validateEnv } from '../config/validation.schema';
import { MODELS } from './mongo/models';
import { DEFAULT_TENANT_ID } from '../modules/identity/tenant.service';
import { normalizeEmail } from '../modules/identity/user.service';
import { hashPassword } from '../common/crypto/crypto.util';
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
// A second resource (Q-24.1) so the SPA/E2E can prove INV-8: a token minted for `other` must be
// REFUSED by `/demo/me`. `fe-sso-test` is allowed BOTH, but the IdP binds one resource per grant
// (no token exchange), so a token for `other` is obtained via a second `/authorize` flow.
const OTHER_RESOURCE_ID = 'other';

export interface SeedDevTargets {
  client: Omit<Client, 'frontchannelLogoutUri'>;
  resources: Resource[];
}

/** Build the target config from the issuer. Identifiers = `${issuer without trailing /}/<id>/`. */
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
      allowedResources: [RESOURCE_ID, OTHER_RESOURCE_ID],
      scopes: ['openid', 'profile', 'email', 'offline_access'],
      tenantId: DEFAULT_TENANT_ID,
    },
    resources: [
      { resourceId: RESOURCE_ID, identifier: `${base}/demo/`, scopes: [] },
      { resourceId: OTHER_RESOURCE_ID, identifier: `${base}/other/`, scopes: [] },
    ],
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

  const { client, resources } = buildSeedDevTargets(issuer);

  validateRedirectUriList(client.redirectUris, { allowHttpLocalhost: true });
  validateRedirectUriList(client.postLogoutRedirectUris, { allowHttpLocalhost: true });
  for (const resource of resources) {
    validateResourceFormat(resource.identifier);
  }

  const clientModel: Model<Client> = connection.models.Client ?? connection.model<Client>('Client');
  const resourceModel: Model<Resource> =
    connection.models.Resource ?? connection.model<Resource>('Resource');

  await upsert(() =>
    clientModel.updateOne({ clientId: client.clientId }, { $set: client }, { upsert: true }).exec(),
  );
  console.log(`seed-dev: upserted client ${client.clientId}`);

  // Key each resource upsert by the stable `resourceId` (never `identifier`): `identifier` is
  // derived from `ISSUER`, so keying by it would insert a second document every time the issuer
  // changes. Keying by `resourceId` updates the single `demo`/`other` resource in place.
  for (const resource of resources) {
    await upsert(() =>
      resourceModel
        .updateOne({ resourceId: resource.resourceId }, { $set: resource }, { upsert: true })
        .exec(),
    );
    console.log(`seed-dev: upserted resource ${resource.resourceId}`);
  }
}

/**
 * Fail-closed environment guard (allowlist, DEBT-098): only `NODE_ENV=development|test` may run the
 * dev seed. `production`, an unset/empty `NODE_ENV` or any other value throws, so the dev seed can
 * never write a production database by a forgotten variable. Called by the CLI BEFORE any DB
 * connection is opened, and again by `seedDev`/`seedDevUser` before any write.
 */
export function assertNotProduction(nodeEnv: string | undefined): void {
  if (nodeEnv !== 'development' && nodeEnv !== 'test') {
    throw new Error(
      `seed-dev: refusing to run with NODE_ENV=${nodeEnv || '(unset)'} (only development|test; never production)`,
    );
  }
}

/**
 * Dev-user seed config (DEBT-076). Read ONLY here, via its own zod schema — deliberately NOT added
 * to the app `envSchema`, so app boot and the integration-test harness never start requiring these
 * variables. A missing/invalid variable fails BEFORE any DB connection with a message naming it.
 * Password reuses the same 8–128 rule as `AuthenticationService.validatePassword` (kept in sync by
 * hand: it is a one-line bound, not worth importing a private method). `DEV_SEED_PASSWORD` is never
 * logged.
 */
const devSeedUserEnvSchema = z.object({
  DEV_SEED_EMAIL: z
    .string({ message: 'DEV_SEED_EMAIL is required' })
    .email('DEV_SEED_EMAIL must be a valid email'),
  DEV_SEED_PASSWORD: z
    .string({ message: 'DEV_SEED_PASSWORD is required' })
    .min(8, 'DEV_SEED_PASSWORD must be between 8 and 128 characters')
    .max(128, 'DEV_SEED_PASSWORD must be between 8 and 128 characters'),
});

export interface DevSeedUserConfig {
  email: string;
  password: string;
  /** `ADMIN_SEED_EMAIL` — the dev user must NOT collide with the admin seed (privilege split). */
  adminEmail: string;
}

/**
 * Parse `DEV_SEED_EMAIL`/`DEV_SEED_PASSWORD` from the environment. Throws (naming the variable) when
 * missing/invalid — the CLI calls this BEFORE opening a DB connection. The password is never echoed
 * in the error (zod only reports the variable name and the bound).
 */
export function readDevSeedUserConfig(
  env: Record<string, unknown>,
  adminEmail: string,
): DevSeedUserConfig {
  const parsed = devSeedUserEnvSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => i.message).join('; ');
    throw new Error(`seed-dev: invalid dev-user environment: ${msg}`);
  }
  return {
    email: parsed.data.DEV_SEED_EMAIL,
    password: parsed.data.DEV_SEED_PASSWORD,
    adminEmail,
  };
}

/**
 * Upsert a single dev user (DEBT-076) that can log in through the real login flow:
 *   - `emailVerifiedAt` is set on insert (clears the `!user.emailVerifiedAt` gate in
 *     `AuthenticationService.login`); kept at its original value on re-seed (`$min` of `now`);
 *   - `failedLoginCount` reset to 0 and `lockedUntil` unset on EVERY run, so a prior failed/locked
 *     run never blocks the next (lockout reset);
 *   - a `UserTenant {tenantId: DEFAULT_TENANT_ID, status: 'active', roles: []}` membership is upserted
 *     (like `register()` → `addMembership`; without it `TenantGuard` returns 403). NO role is granted:
 *     the dev user is a plain non-admin, deliberately separate from the admin seed.
 *
 * Idempotent: keyed by the normalized email (unique index) for the user and by `(userId, tenantId)`
 * for the membership, so running twice converges to one user + one membership. Fail-closed on
 * environment: `assertNotProduction` runs BEFORE any write. The password is hashed with Argon2id
 * (same as `UserService`) and never logged.
 *
 * NOTE (dev-only): if the email already exists (e.g. registered by hand), this OVERWRITES its
 * password hash — acceptable because the tool is dev-only and refuses production. See README.
 */
export async function seedDevUser(
  connection: Connection,
  config: DevSeedUserConfig,
  nodeEnv: string | undefined,
  now: Date = new Date(),
): Promise<void> {
  // Fail-closed BEFORE any write: this dev tool must never mutate a production database.
  assertNotProduction(nodeEnv);

  const email = normalizeEmail(config.email);
  // Privilege split: never seed a dev user over the admin seed account (B6.4 grants admin roles by
  // ADMIN_SEED_EMAIL; a collision would hand the dev user admin privileges).
  if (email === normalizeEmail(config.adminEmail)) {
    throw new Error('seed-dev: DEV_SEED_EMAIL must differ from ADMIN_SEED_EMAIL');
  }

  const passwordHash = await hashPassword(config.password);

  const userModel: Model<unknown> = connection.models.User ?? connection.model('User');
  const userTenantModel: Model<unknown> =
    connection.models.UserTenant ?? connection.model('UserTenant');

  await upsert(() =>
    userModel
      .updateOne(
        { email },
        {
          $set: { passwordHash, failedLoginCount: 0 },
          $min: { emailVerifiedAt: now },
          $unset: { lockedUntil: 1 },
        },
        { upsert: true },
      )
      .exec(),
  );

  const userDoc = await userModel
    .findOne({ email })
    .select('_id')
    .lean<{ _id: Types.ObjectId }>()
    .exec();
  if (!userDoc) throw new Error('seed-dev: dev user disappeared after upsert');
  const userId = userDoc._id;

  await upsert(() =>
    userTenantModel
      .updateOne(
        { userId, tenantId: DEFAULT_TENANT_ID },
        { $set: { status: 'active' }, $setOnInsert: { roles: [] } },
        { upsert: true },
      )
      .exec(),
  );

  // Log identifiers only — never the password or its hash.
  console.log(`seed-dev: upserted user ${userId.toString()} <${email}>`);
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
  // Read dev-user config BEFORE opening a DB connection, so a missing/invalid DEV_SEED_* variable
  // fails fast (naming the variable) without touching the database. DEV_SEED_* is NOT part of the
  // app `envSchema` — it is read here only.
  const devUser = readDevSeedUserConfig(process.env, env.ADMIN_SEED_EMAIL);

  const connection = await mongoose
    .createConnection(env.MONGO_URI, { autoIndex: false, serverSelectionTimeoutMS: 5000 })
    .asPromise();
  // Register schemas so index/validation behave like the running app.
  for (const { name, schema } of MODELS) {
    if (!connection.models[name]) connection.model(name, schema);
  }
  try {
    await seedDev(connection, env.ISSUER, process.env.NODE_ENV);
    await seedDevUser(connection, devUser, process.env.NODE_ENV);
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
