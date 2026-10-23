import mongoose, { type Connection, type Model, type Types } from 'mongoose';
import { verifyPassword, hashPassword } from '../../src/common/crypto/crypto.util';
import { validateEnv } from '../../src/config/validation.schema';
import { MODELS } from '../../src/database/mongo/models';
import { upsert } from '../../src/database/seed-dev';
import {
  buildFeAdminClient,
  readAdminSeedConfig,
  seedBootstrap,
  type AdminSeedConfig,
} from '../../src/database/seed';
import { DEFAULT_TENANT_ID } from '../../src/modules/identity/tenant.service';
import { normalizeEmail } from '../../src/modules/identity/user.service';
import {
  ClientCredentialService,
  type ClientCredential,
} from '../../src/modules/clients/client-credential.service';
import type { ConfigService } from '@nestjs/config';

/**
 * E2E-only admin seed (run 39 Task 0, Q-39.1): `pnpm -C be seed:e2e-admin`, run by the Playwright
 * BE webServer after `db:seed-dev`. Lives outside `src/` (never in `dist/`, guarded by the
 * `seed-e2e-admin` marker of `assert-dist-clean.mjs`).
 *
 * Fail-closed BEFORE connecting: only `NODE_ENV=test` AND a `MONGO_URI` whose database is exactly
 * `sso-idp-e2e`. Then, idempotently:
 *   1. `seedBootstrap` in-process (its one-time random `fe-admin` secret is discarded, never printed);
 *   2. `fe-admin` gets a credential for the known `E2E_FE_ADMIN_SECRET` (placeholder in
 *      `e2e/config/env.ts`): nothing is written when it already verifies, otherwise every active
 *      credential is revoked and the next version is inserted with that secret's hash;
 *   3. the admin user's password is reset to `ADMIN_SEED_PASSWORD` and its lock cleared, so a
 *      failed earlier run cannot lock the admin out of the next one;
 *   4. (run 47, Q-47.3) when `E2E_USER_EMAIL`/`E2E_USER_PASSWORD` are set, a separate non-admin
 *      target user (lock/revoke specs) is converged: verified, password, no lock, an active
 *      membership of the default tenant with NO role. Never the admin nor the dev user.
 * Nothing secret is written to stdout/stderr.
 */

export const E2E_DB_NAME = 'sso-idp-e2e';
const MIN_SECRET_LENGTH = 32;

function mongoDbName(uri: string): string | undefined {
  const m = /^mongodb(?:\+srv)?:\/\/[^/?#]*\/([^/?#]*)/.exec(uri);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return undefined;
  }
}

/** Pure guard, run before any connection. Messages never echo the URI or the secret. */
export function assertE2eSeedTarget(env: Record<string, string | undefined>): {
  mongoUri: string;
  feAdminSecret: string;
} {
  if (env.NODE_ENV !== 'test') {
    throw new Error(
      `seed-e2e-admin: refusing to run with NODE_ENV=${env.NODE_ENV || '(unset)'} (only test)`,
    );
  }
  const mongoUri = env.MONGO_URI;
  if (!mongoUri || mongoDbName(mongoUri) !== E2E_DB_NAME) {
    throw new Error(
      `seed-e2e-admin: refusing to run: MONGO_URI must name the database ${E2E_DB_NAME} exactly`,
    );
  }
  const feAdminSecret = env.E2E_FE_ADMIN_SECRET;
  if (!feAdminSecret || feAdminSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `seed-e2e-admin: E2E_FE_ADMIN_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  }
  return { mongoUri, feAdminSecret };
}

export interface E2eUserConfig {
  email: string;
  password: string;
}

const E2E_USER_COLLISION =
  'seed-e2e-admin: E2E_USER_EMAIL must differ from ADMIN_SEED_EMAIL and DEV_SEED_EMAIL';

/**
 * The E2E target user, read before connecting. Either variable missing/empty => `undefined` (the
 * step is skipped). Throws when it names the admin seed or the dev user: other specs sign in with
 * those, and the target gets locked/revoked. Never echoes the password.
 */
export function readE2eUserConfig(
  env: Record<string, string | undefined>,
): E2eUserConfig | undefined {
  const { E2E_USER_EMAIL: email, E2E_USER_PASSWORD: password } = env;
  if (!email || !password) return undefined;
  const n = normalizeEmail(email);
  if ([env.ADMIN_SEED_EMAIL, env.DEV_SEED_EMAIL].some((r) => r && normalizeEmail(r) === n)) {
    throw new Error(E2E_USER_COLLISION);
  }
  return { email, password };
}

export async function seedE2eAdmin(
  connection: Connection,
  cfg: AdminSeedConfig,
  issuer: string,
  nodeEnv: string | undefined,
  feAdminSecret: string,
  e2eUser?: E2eUserConfig,
): Promise<void> {
  // Second guard before any write (a caller may reach this without `assertE2eSeedTarget`).
  if (nodeEnv !== 'test') throw new Error('seed-e2e-admin: only NODE_ENV=test');
  if (e2eUser && normalizeEmail(e2eUser.email) === normalizeEmail(cfg.email)) {
    throw new Error(E2E_USER_COLLISION);
  }

  // The one-time random secret it may return is dropped here on purpose (never printed).
  await seedBootstrap(connection, cfg, issuer, nodeEnv);

  const clientId = buildFeAdminClient().clientId;
  const credentialModel =
    (connection.models.ClientCredential as Model<ClientCredential> | undefined) ??
    connection.model<ClientCredential>('ClientCredential');
  const credentials = new ClientCredentialService(credentialModel, {
    getOrThrow: () => ({ secretGraceTtl: 0 }),
  } as unknown as ConfigService);
  const { valid } = await credentials.verifySecret(clientId, feAdminSecret);
  if (valid) {
    console.log(`seed-e2e-admin: ${clientId} credential unchanged`);
  } else {
    await credentials.revokeAll(clientId, new Date());
    const latest = await credentialModel
      .findOne({ clientId })
      .sort({ version: -1 })
      .lean<{ version: number } | null>()
      .exec();
    const version = (latest?.version ?? 0) + 1;
    await credentialModel.create({
      clientId,
      secretHash: await hashPassword(feAdminSecret),
      version,
    });
    console.log(`seed-e2e-admin: ${clientId} credential replaced (v${version})`);
  }

  await resetAdminUser(connection, cfg);
  if (e2eUser) await seedE2eUser(connection, e2eUser);
  else console.log('seed-e2e-admin: E2E user skipped (E2E_USER_EMAIL/E2E_USER_PASSWORD unset)');
}

/** True when `hash` verifies `password`; a corrupt/foreign hash throws => "needs reset". */
async function passwordMatches(hash: string | undefined, password: string): Promise<boolean> {
  try {
    return !!hash && (await verifyPassword(hash, password));
  } catch {
    return false;
  }
}

/** Admin user: reset password + lock only when needed (no write on a converged DB). */
async function resetAdminUser(connection: Connection, cfg: AdminSeedConfig): Promise<void> {
  const email = normalizeEmail(cfg.email);
  const userModel = connection.models.User ?? connection.model('User');
  const user = await userModel
    .findOne({ email })
    .select('+passwordHash')
    .lean<{ passwordHash?: string; failedLoginCount?: number; lockedUntil?: Date | null }>()
    .exec();
  if (!user) throw new Error('seed-e2e-admin: admin user missing after seedBootstrap');
  const passwordOk = await passwordMatches(user.passwordHash, cfg.password);
  if (passwordOk && !user.failedLoginCount && user.lockedUntil == null) {
    console.log('seed-e2e-admin: admin user unchanged');
    return;
  }
  const passwordHash = await hashPassword(cfg.password);
  await upsert(() =>
    userModel
      .updateOne(
        { email },
        { $set: { passwordHash, failedLoginCount: 0 }, $unset: { lockedUntil: 1 } },
      )
      .exec(),
  );
  console.log('seed-e2e-admin: admin user password/lock reset');
}

/**
 * E2E target user: verified, known password, no lock, membership `{DEFAULT_TENANT_ID, active,
 * roles: []}`. Each part is written only when it drifted (a converged DB gets no write).
 */
async function seedE2eUser(connection: Connection, cfg: E2eUserConfig): Promise<void> {
  const email = normalizeEmail(cfg.email);
  const userModel = connection.models.User ?? connection.model('User');
  const memberModel = connection.models.UserTenant ?? connection.model('UserTenant');
  type Row = {
    _id: Types.ObjectId;
    passwordHash?: string;
    failedLoginCount?: number;
    lockedUntil?: Date | null;
    emailVerifiedAt?: Date | null;
  };
  const findUser = () =>
    userModel.findOne({ email }).select('+passwordHash').lean<Row | null>().exec();

  let user = await findUser();
  const userOk =
    !!user &&
    !user.failedLoginCount &&
    user.lockedUntil == null &&
    user.emailVerifiedAt != null &&
    (await passwordMatches(user.passwordHash, cfg.password));
  if (!userOk) {
    const passwordHash = await hashPassword(cfg.password);
    await upsert(() =>
      userModel
        .updateOne(
          { email },
          {
            $set: { passwordHash, failedLoginCount: 0 },
            $min: { emailVerifiedAt: new Date() },
            $unset: { lockedUntil: 1 },
          },
          { upsert: true },
        )
        .exec(),
    );
    user = await findUser();
  }
  if (!user) throw new Error('seed-e2e-admin: E2E user missing after upsert');
  const userId = user._id;

  const member = await memberModel
    .findOne({ userId, tenantId: DEFAULT_TENANT_ID })
    .lean<{ status?: string; roles?: string[] } | null>()
    .exec();
  const memberOk = member?.status === 'active' && (member.roles ?? []).length === 0;
  if (!memberOk) {
    await upsert(() =>
      memberModel
        .updateOne(
          { userId, tenantId: DEFAULT_TENANT_ID },
          { $set: { status: 'active', roles: [] } },
          { upsert: true },
        )
        .exec(),
    );
  }
  // Identifier only, never the password or its hash.
  console.log(
    userOk && memberOk
      ? 'seed-e2e-admin: E2E user unchanged'
      : `seed-e2e-admin: E2E user reset (${userId.toHexString()})`,
  );
}

async function main(): Promise<void> {
  // Fail-closed BEFORE any DB connection.
  const { mongoUri, feAdminSecret } = assertE2eSeedTarget(process.env);
  const env = validateEnv(process.env);
  const admin = readAdminSeedConfig(process.env);
  const e2eUser = readE2eUserConfig(process.env);

  const connection = await mongoose
    .createConnection(mongoUri, { autoIndex: false, serverSelectionTimeoutMS: 5000 })
    .asPromise();
  for (const { name, schema } of MODELS) {
    if (!connection.models[name]) connection.model(name, schema);
  }
  try {
    await seedE2eAdmin(connection, admin, env.ISSUER, process.env.NODE_ENV, feAdminSecret, e2eUser);
  } finally {
    await connection.close();
  }
}

// `require` is undefined when imported under ESM (Jest); ts-node runs this file as CJS.
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((err: Error) => {
    console.error(`seed-e2e-admin failed: ${err.message}`);
    process.exit(1);
  });
}
