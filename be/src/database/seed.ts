import mongoose, { type ClientSession, type Connection, type Model, type Types } from 'mongoose';
import type { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { validateEnv } from '../config/validation.schema';
import { buildModels, MODELS } from './mongo/models';
import { cliErrorText, isDryRun, mongoTarget } from './mongo/sync-indexes';
import { assertDevOrTestEnv, seedDev, upsert } from './seed-dev';
import { DEFAULT_TENANT_ID } from '../modules/identity/tenant.service';
import { normalizeEmail } from '../modules/identity/user.service';
import { hashPassword } from '../common/crypto/crypto.util';
import type { Client } from '../modules/clients/client.service';
import {
  ClientCredentialService,
  type ClientCredential,
} from '../modules/clients/client-credential.service';
import type { Resource } from '../modules/resources/resource.service';
import { validateRedirectUriList } from '../modules/clients/redirect-uri.validator';
import { validateResourceIdentifier } from '../modules/resources/resource.validator';
import { adminResourceIdentifier } from '../modules/oauth/token/token.service';

/**
 * Bootstrap seed CLI (B6.4, run 30): `pnpm db:seed`. Dev/test only (`assertDevOrTestEnv`
 * allowlist, before connecting AND before any write) — production is not supported yet (DEBT-164).
 *
 * Seeds, idempotently (upserts keyed by stable keys; a re-run converges, never duplicates):
 *   1. tenant `default-tenant` (`$setOnInsert`, same as `TenantService.seedDefault`);
 *   2. resource `admin` (`adminResourceIdentifier(issuer)`, scopes `admin.read/admin.write`),
 *      INSERT-ONLY (`$setOnInsert`): the seed never re-points nor resets an existing `admin`
 *      (DEBT-173) + `demo`/`other` and client `fe-sso-test` via `seedDev` (one source of truth);
 *   3. the admin user (`ADMIN_SEED_EMAIL`/`ADMIN_SEED_PASSWORD`) with `super_admin` in the default
 *      tenant. An EXISTING user keeps its password and lock (`$setOnInsert`); the membership is
 *      re-activated and `super_admin` re-added (recovery path when no super_admin is left);
 *   4. confidential client `fe-admin` (`$setOnInsert`: never overwrites config edited via the API,
 *      never re-enables a disabled client);
 *   5. a `fe-admin` secret ONLY when it has no active credential. The raw secret is RETURNED to the
 *      caller (the CLI prints it once on stdout) — never logged, audited or written to a file.
 *
 * Two concurrent runs may both create (and print) a secret: accepted for this dev/test tool (one
 * operator). Production uses `db:bootstrap` (run 88, `bootstrap.ts`), which shares steps 0, 1, 2 and
 * 4 through `ensureAdminPlane` and runs them in one transaction (DEBT-164).
 */

export const ADMIN_RESOURCE_ID = 'admin';
export const FE_ADMIN_CLIENT_ID = 'fe-admin';

/**
 * Admin seed config, read only here (zod, before any DB connection). The password bound (12–128)
 * is stricter than the user rule (8–128): this account is a super_admin. Errors name the variable
 * and the bound only — never the value.
 */
const adminSeedEnvSchema = z.object({
  ADMIN_SEED_EMAIL: z
    .string({ message: 'ADMIN_SEED_EMAIL is required' })
    .email('ADMIN_SEED_EMAIL must be a valid email'),
  ADMIN_SEED_PASSWORD: z
    .string({ message: 'ADMIN_SEED_PASSWORD is required' })
    .min(12, 'ADMIN_SEED_PASSWORD must be between 12 and 128 characters')
    .max(128, 'ADMIN_SEED_PASSWORD must be between 12 and 128 characters'),
});

export interface AdminSeedConfig {
  email: string;
  password: string;
}

export function readAdminSeedConfig(env: Record<string, unknown>): AdminSeedConfig {
  const parsed = adminSeedEnvSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => i.message).join('; ');
    throw new Error(`seed: invalid admin environment: ${msg}`);
  }
  return { email: parsed.data.ADMIN_SEED_EMAIL, password: parsed.data.ADMIN_SEED_PASSWORD };
}

export interface FeAdminUris {
  redirectUris: string[];
  postLogoutRedirectUris: string[];
}

/** Dev/test default (`db:seed`); `db:bootstrap` passes the URIs of its env (D88.4). */
export function buildFeAdminClient(
  uris: FeAdminUris = {
    redirectUris: ['http://localhost:3000/auth/callback'],
    postLogoutRedirectUris: ['http://localhost:3000/'],
  },
): Omit<Client, 'frontchannelLogoutUri'> {
  return {
    clientId: FE_ADMIN_CLIENT_ID,
    clientType: 'confidential',
    tokenEndpointAuthMethod: 'client_secret_basic',
    grantTypes: ['authorization_code', 'refresh_token'],
    redirectUris: [...uris.redirectUris],
    postLogoutRedirectUris: [...uris.postLogoutRedirectUris],
    allowedCorsOrigins: [], // BFF: token calls are server-side
    allowedResources: [ADMIN_RESOURCE_ID],
    scopes: ['openid', 'profile', 'email', 'offline_access', 'admin.read', 'admin.write'],
    tenantId: DEFAULT_TENANT_ID,
  };
}

function model<T>(connection: Connection, name: string): Model<T> {
  return (connection.models[name] as Model<T> | undefined) ?? connection.model<T>(name);
}

export interface AdminPlaneCreated {
  tenant: boolean;
  resource: boolean;
  client: boolean;
}

/**
 * Steps 0, 1, 2 and 4 of the seed, shared with `db:bootstrap` (run 88, D88.3): re-point guards,
 * tenant, resource `admin` (+ post-check) and client `feAdmin`, all insert-only. Without `session`
 * (seed) an E11000 of a concurrent upsert is swallowed (`upsert`); with one (bootstrap transaction)
 * every error propagates so the transaction aborts. Returns what this call inserted.
 */
export async function ensureAdminPlane(
  connection: Connection,
  opts: { issuer: string; feAdmin: Omit<Client, 'frontchannelLogoutUri'>; label: string },
  session?: ClientSession,
): Promise<AdminPlaneCreated> {
  const { feAdmin, label } = opts;
  const adminIdentifier = adminResourceIdentifier(opts.issuer);
  const tenantModel = model<unknown>(connection, 'Tenant');
  const resourceModel = model<Resource>(connection, 'Resource');
  const clientModel = model<Client>(connection, 'Client');
  const write = async (run: () => Promise<{ upsertedCount: number }>): Promise<boolean> => {
    if (session) return (await run()).upsertedCount === 1;
    let inserted = false;
    await upsert(async () => (inserted = (await run()).upsertedCount === 1));
    return inserted;
  };

  // 0. Guard, BEFORE any write (DEBT-137/173 via seed). The seed NEVER re-points `admin` (step 2 is
  // insert-only), so:
  //  (i) `admin` exists with another identifier (created via the API, or seeded under another
  //      ISSUER) => refuse, whoever references it — no exception: the operator fixes or deletes
  //      the record, then re-runs;
  // (ii) `admin` does not exist but a client already references it => refuse (the insert would make
  //      that client admin-capable without rule A / rule B).
  // No check-then-write race with the API: while `admin` is absent, tenant_admin cannot attach it
  // (`assertAllowedResources` needs the resource), and an existing `admin` is never rewritten here.
  const admins = await resourceModel
    .find({ resourceId: ADMIN_RESOURCE_ID })
    .select('identifier')
    .session(session ?? null)
    .lean<Pick<Resource, 'identifier'>[]>()
    .exec();
  const foreign = admins.find((r) => r.identifier !== adminIdentifier);
  if (foreign) {
    throw new Error(
      `${label}: refusing to point resource '${ADMIN_RESOURCE_ID}' at ${adminIdentifier}: it already ` +
        `exists with identifier ${foreign.identifier} (the ${label} never re-points it) — fix or ` +
        'delete that resource (and the clients referencing it) first',
    );
  }
  if (admins.length === 0) {
    const referrer = await clientModel
      .findOne({ allowedResources: ADMIN_RESOURCE_ID })
      .select('clientId')
      .session(session ?? null)
      .lean<Pick<Client, 'clientId'>>()
      .exec();
    if (referrer) {
      throw new Error(
        `${label}: refusing to point resource '${ADMIN_RESOURCE_ID}' at ${adminIdentifier}: client ` +
          `${referrer.clientId} already references it and would become admin-capable without the ` +
          'DEBT-137 checks — remove the reference (or the client) first',
      );
    }
  }

  // 1. Tenant.
  const tenant = await write(() =>
    tenantModel
      .updateOne(
        { id: DEFAULT_TENANT_ID },
        { $setOnInsert: { id: DEFAULT_TENANT_ID, name: 'Default' } },
        { upsert: true, session },
      )
      .exec(),
  );

  // 2. Resource `admin`, then a MANDATORY post-check: `upsert` swallows E11000 and `resourceId` is
  // not unique (DEBT-127), so an admin identifier already registered under another `resourceId`
  // would silently leave `fe-admin` pointing at a resource that does not exist.
  const resource = await write(() =>
    resourceModel
      .updateOne(
        { resourceId: ADMIN_RESOURCE_ID },
        {
          $setOnInsert: {
            resourceId: ADMIN_RESOURCE_ID,
            identifier: adminIdentifier,
            scopes: ['admin.read', 'admin.write'],
          },
        },
        { upsert: true, session },
      )
      .exec(),
  );
  const adminResource = await resourceModel
    .exists({ resourceId: ADMIN_RESOURCE_ID, identifier: adminIdentifier })
    .session(session ?? null)
    .exec();
  if (!adminResource) {
    throw new Error(
      `${label}: resource '${ADMIN_RESOURCE_ID}' with identifier ${adminIdentifier} could not be ensured ` +
        '(identifier already registered under another resourceId?) — fix the resources collection first',
    );
  }

  // 4. Client `fe-admin` (insert-only: never overwrites config edited via the API, never re-enables).
  const client = await write(() =>
    clientModel
      .updateOne(
        { clientId: feAdmin.clientId },
        { $setOnInsert: feAdmin },
        { upsert: true, session },
      )
      .exec(),
  );
  return { tenant, resource, client };
}

export async function seedBootstrap(
  connection: Connection,
  cfg: AdminSeedConfig,
  issuer: string,
  nodeEnv: string | undefined,
  now: Date = new Date(),
): Promise<{ feAdminSecret?: string }> {
  // Fail-closed BEFORE any write (the CLI also refuses before connecting).
  assertDevOrTestEnv(nodeEnv);

  const feAdmin = buildFeAdminClient();
  const adminIdentifier = adminResourceIdentifier(issuer);
  validateRedirectUriList(feAdmin.redirectUris, { allowHttpLocalhost: true });
  validateRedirectUriList(feAdmin.postLogoutRedirectUris, { allowHttpLocalhost: true });
  validateResourceIdentifier(adminIdentifier);
  const email = normalizeEmail(cfg.email);

  const userModel = model<unknown>(connection, 'User');
  const userTenantModel = model<unknown>(connection, 'UserTenant');
  const credentialModel = model<ClientCredential>(connection, 'ClientCredential');

  // Unique indexes BEFORE any write (DEBT-176): on a DB never synced, two concurrent runs would
  // otherwise both insert. `createIndexes` only creates what is missing (never drops, unlike
  // `db:sync-indexes`). A failure (duplicates already present, conflicting index) => no write.
  for (const { name, schema } of MODELS) {
    const m = connection.models[name] ?? connection.model(name, schema);
    try {
      await m.createIndexes();
    } catch (err) {
      // Only the model + error code: an E11000 message would echo the duplicated value (PII).
      const { code: rawCode, codeName } = err as { code?: unknown; codeName?: unknown };
      const code = codeName ?? rawCode;
      // DEBT-180: the dedupe advice only for a duplicate / conflicting index; any other failure
      // (not primary, auth, network...) keeps the original as `cause` (the CLI prints `message`).
      if (
        rawCode === 11000 ||
        codeName === 'IndexOptionsConflict' ||
        codeName === 'IndexKeySpecsConflict'
      ) {
        throw new Error(
          `seed: ensuring the ${name} indexes failed (${String(code)}) — remove ` +
            'duplicated documents / run `pnpm db:sync-indexes` first; nothing was written',
        );
      }
      throw new Error(
        `seed: ensuring the ${name} indexes failed (${String(code ?? 'error')}) — nothing was written`,
        { cause: err },
      );
    }
  }

  await ensureAdminPlane(connection, { issuer, feAdmin, label: 'seed' });
  console.log(`seed: ensured resource ${ADMIN_RESOURCE_ID}`);
  await seedDev(connection, issuer, nodeEnv);

  // 3. Admin user: `$setOnInsert` only — a re-run never resets the password nor clears a lock.
  const passwordHash = await hashPassword(cfg.password);
  await upsert(() =>
    userModel
      .updateOne(
        { email },
        { $setOnInsert: { passwordHash, emailVerifiedAt: now } },
        { upsert: true },
      )
      .exec(),
  );
  const userDoc = await userModel
    .findOne({ email })
    .select('_id')
    .lean<{ _id: Types.ObjectId }>()
    .exec();
  if (!userDoc) throw new Error('seed: admin user disappeared after upsert');
  const userId = userDoc._id;
  if (!(await userModel.exists({ email, passwordHash: { $exists: true } }).exec())) {
    console.warn(`seed: admin user <${email}> exists without a password (left unchanged)`);
  }
  await upsert(() =>
    userTenantModel
      .updateOne(
        { userId, tenantId: DEFAULT_TENANT_ID },
        { $set: { status: 'active' }, $addToSet: { roles: 'super_admin' } },
        { upsert: true },
      )
      .exec(),
  );
  console.log(`seed: ensured super_admin ${userId.toString()} <${email}>`);

  // 4. Client `fe-admin`: inserted (insert-only) by `ensureAdminPlane` above.
  console.log(`seed: ensured client ${feAdmin.clientId}`);

  // 5. Secret only when none is active; never rotated by a re-run.
  const credentials = new ClientCredentialService(credentialModel, {
    getOrThrow: () => ({ secretGraceTtl: 0 }),
  } as unknown as ConfigService);
  if (await credentials.hasActive(feAdmin.clientId)) return {};
  const issued = await credentials.createSecret(feAdmin.clientId);
  return { feAdminSecret: issued.secret };
}

async function main(): Promise<void> {
  const dryRun = isDryRun(process.argv);
  // Fail-closed BEFORE any DB connection.
  assertDevOrTestEnv(process.env.NODE_ENV);
  const env = validateEnv(process.env);
  const admin = readAdminSeedConfig(process.env);
  console.log(mongoTarget(env.MONGO_URI));
  if (dryRun) {
    console.log('dry-run: no connection made');
    return;
  }

  const connection = await mongoose
    .createConnection(env.MONGO_URI, { autoIndex: false, serverSelectionTimeoutMS: 5000 })
    .asPromise();
  for (const { name, schema } of buildModels(env.AUDIT_RETENTION_DAYS)) {
    if (!connection.models[name]) connection.model(name, schema);
  }
  try {
    const { feAdminSecret } = await seedBootstrap(
      connection,
      admin,
      env.ISSUER,
      process.env.NODE_ENV,
    );
    // The ONLY place the secret leaves the process: stdout, once (not the logger, not a file).
    if (feAdminSecret) {
      process.stdout.write(`fe-admin client_secret (shown once): ${feAdminSecret}\n`);
    }
  } finally {
    await connection.close();
  }
}

// `require` is undefined when imported under ESM (Jest); the built CLI is CJS.
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((err: unknown) => {
    console.error(`seed failed: ${cliErrorText(err, process.env.MONGO_URI)}`);
    process.exit(1);
  });
}
