import mongoose, { type ClientSession, type Connection } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { z } from 'zod';
import { generateToken, hashPassword } from '../common/crypto/crypto.util';
import { validateEnv } from '../config/validation.schema';
import { validateRedirectUriList } from '../modules/clients/redirect-uri.validator';
import { DEFAULT_TENANT_ID } from '../modules/identity/tenant.service';
import { ADMIN_LOCKED_UNTIL } from '../modules/identity/user.service';
import {
  adminResourceIdentifier,
  isAdminCapableClient,
} from '../modules/oauth/token/token.service';
import { validateResourceIdentifier } from '../modules/resources/resource.validator';
import { AuditAction } from '../modules/security/audit/audit-action.enum';
import { sanitizeMetadata } from '../modules/security/audit/audit.service';
import type { AuditEvent, AuditMetadata } from '../modules/security/audit/audit.types';
import { buildModels } from './mongo/models';
import { cliErrorText, mongoTarget } from './mongo/sync-indexes';
import { buildFeAdminClient, ensureAdminPlane, FE_ADMIN_CLIENT_ID, type FeAdminUris } from './seed';

/**
 * Production bootstrap (run 88, DEBT-164/165, D88.2–D88.14): `node dist/database/bootstrap.js` with
 * the APP's own env (`validateEnv`, any NODE_ENV) plus `BOOTSTRAP_FE_ADMIN_*` URIs. Ensures only the
 * admin control plane: tenant `default-tenant`, resource `admin`, client `fe-admin` and ONE active
 * credential. Never touches users, memberships, Redis or signing keys (the first super_admin
 * registers then goes through `db:admin-recover`, D88.12).
 *
 * Concurrency (D88.6): every write runs in ONE transaction whose first statement touches
 * `opslocks {_id:'bootstrap'}`; two runs write-conflict there, the driver retries the loser on a
 * fresh snapshot, which then sees the active credential and issues none. The secret and its hash are
 * generated BEFORE the transaction (the callback may re-run) and printed only AFTER the commit.
 */
export interface BootstrapArgs {
  operator: string;
  ticket?: string;
  updateUris: boolean;
  rotateSecret: boolean;
  dryRun: boolean;
}

export interface BootstrapIo {
  /** One output line (stdout). A rejected promise for the secret line => exit 1 (D88.7). */
  write: (line: string) => void | Promise<void>;
  now?: () => Date;
  /** Test seam (AC3 barrier): awaited inside the transaction, right before the `opslocks` touch. */
  beforeTouch?: () => Promise<void>;
}

export type BootstrapResult =
  | {
      status: 'ok';
      eventId: string;
      created: { tenant: boolean; resource: boolean; client: boolean };
      secretIssued: boolean;
      secretRotated: boolean;
      urisUpdated: boolean;
      usableSuperAdmins: number;
    }
  | { status: 'drift' };

const OPERATOR = /^[a-z0-9._-]{2,64}$/;
const TICKET = /^[A-Za-z0-9._#/-]{1,64}$/;
const VALUE_FLAGS = ['--operator', '--ticket'] as const;
const SWITCHES = ['--update-uris', '--rotate-secret', '--dry-run'] as const;

/** Allowlist parse of `process.argv` (D88.5). Every error is a fixed text: no value is echoed. */
export function parseBootstrapArgs(argv: readonly string[]): BootstrapArgs {
  const args = argv.slice(2).filter((a) => a !== '--');
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((SWITCHES as readonly string[]).includes(a)) {
      if (switches.has(a)) throw new Error('argument repeated');
      switches.add(a);
    } else if ((VALUE_FLAGS as readonly string[]).includes(a)) {
      if (values.has(a)) throw new Error('argument repeated');
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error('argument without value');
      values.set(a, v);
      i++;
    } else {
      throw new Error(`unknown argument (allowed: ${[...VALUE_FLAGS, ...SWITCHES].join(' ')})`);
    }
  }
  const operator = values.get('--operator') ?? '';
  if (!OPERATOR.test(operator)) {
    throw new Error('--operator is required and must match [a-z0-9._-]{2,64}');
  }
  const ticket = values.get('--ticket');
  if (ticket !== undefined && !TICKET.test(ticket)) {
    throw new Error('--ticket must match [A-Za-z0-9._#/-]{1,64}');
  }
  const updateUris = switches.has('--update-uris');
  const rotateSecret = switches.has('--rotate-secret');
  if ((updateUris || rotateSecret) && ticket === undefined) {
    throw new Error('--update-uris and --rotate-secret require --ticket');
  }
  return {
    operator,
    ...(ticket !== undefined ? { ticket } : {}),
    updateUris,
    rotateSecret,
    dryRun: switches.has('--dry-run'),
  };
}

const URI_VARS = {
  redirectUris: 'BOOTSTRAP_FE_ADMIN_REDIRECT_URIS',
  postLogoutRedirectUris: 'BOOTSTRAP_FE_ADMIN_POST_LOGOUT_REDIRECT_URIS',
} as const;

const uriListEnv = z.string().optional();

/**
 * The bootstrap-only env (D88.4, not in the app `envSchema`): two comma-separated lists, 1–10
 * entries each, validated like the admin API does (`https` only in production). Errors name the
 * variable and the entry position, never a value.
 */
export function readBootstrapEnv(env: Record<string, unknown>): FeAdminUris {
  const allowHttpLocalhost = env.NODE_ENV !== 'production';
  const read = (name: string): string[] => {
    const parsed = uriListEnv.safeParse(env[name]);
    const raw = parsed.success ? (parsed.data ?? '') : '';
    const list = raw
      .split(',')
      .map((u) => u.trim())
      .filter((u) => u !== '');
    if (list.length < 1 || list.length > 10) {
      throw new Error(`${name} must list 1 to 10 comma-separated URIs`);
    }
    if (new Set(list).size !== list.length) throw new Error(`${name} has a duplicated entry`);
    list.forEach((uri, i) => {
      try {
        validateRedirectUriList([uri], { allowHttpLocalhost });
      } catch (err) {
        throw new Error(`${name} entry ${i + 1} is invalid: ${(err as Error).message}`);
      }
    });
    return list;
  };
  return {
    redirectUris: read(URI_VARS.redirectUris),
    postLogoutRedirectUris: read(URI_VARS.postLogoutRedirectUris),
  };
}

/** The unique indexes the bootstrap relies on (D88.10); it never creates them itself. */
const REQUIRED_UNIQUE: { collection: string; key: Record<string, number> }[] = [
  { collection: 'clients', key: { clientId: 1 } },
  { collection: 'resources', key: { identifier: 1 } },
  { collection: 'clientcredentials', key: { clientId: 1, version: 1 } },
];

async function assertUniqueIndexes(conn: Connection): Promise<void> {
  for (const { collection, key } of REQUIRED_UNIQUE) {
    let indexes: { key: Record<string, unknown>; unique?: boolean }[] = [];
    try {
      indexes = (await conn.collection(collection).listIndexes().toArray()) as typeof indexes;
    } catch {
      indexes = []; // NamespaceNotFound: collection never created => no index either
    }
    const want = JSON.stringify(key);
    if (!indexes.some((ix) => ix.unique === true && JSON.stringify(ix.key) === want)) {
      throw new Error(
        `missing unique index ${collection} ${want}: run db:sync-indexes first (nothing was written)`,
      );
    }
  }
}

async function assertReplicaSet(conn: Connection): Promise<void> {
  const db = conn.db;
  if (!db) throw new Error('no database handle');
  const hello = (await db.admin().command({ hello: 1 })) as { setName?: string; msg?: string };
  if (!hello.setName && hello.msg !== 'isdbgrid') {
    throw new Error('db:bootstrap requires a replica set (or mongos); nothing was written');
  }
}

const SUPER_ADMINS = { tenantId: DEFAULT_TENANT_ID, status: 'active', roles: 'super_admin' };

/** Read-only count of usable super_admins of `default-tenant`, as `SuperAdminGuard` counts them. */
async function usableSuperAdmins(conn: Connection): Promise<number> {
  const rows = await conn
    .collection('usertenants')
    .find(SUPER_ADMINS, { projection: { userId: 1 } })
    .toArray();
  if (rows.length === 0) return 0;
  return conn.collection('users').countDocuments({
    _id: { $in: rows.map((r) => r.userId as never) },
    lockedUntil: { $ne: ADMIN_LOCKED_UNTIL },
  });
}

/** A refusal decided inside the transaction (D88.10): aborts it, message printed as is. */
class Refusal extends Error {}

class Drift extends Error {
  constructor(
    readonly stored: FeAdminUris,
    readonly wanted: FeAdminUris,
  ) {
    super('drift');
  }
}

const sameList = (a: readonly string[] = [], b: readonly string[] = []) =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

type ClientRow = {
  clientType?: string;
  tokenEndpointAuthMethod?: string;
  redirectUris?: string[];
  postLogoutRedirectUris?: string[];
};

/** The CLI core (exported for the int spec). Refusals and DB errors throw; nothing was written. */
export async function bootstrapAdminPlane(
  conn: Connection,
  opts: { issuer: string; uris: FeAdminUris; args: BootstrapArgs },
  io: BootstrapIo,
): Promise<BootstrapResult> {
  const now = io.now ?? (() => new Date());
  const { args, uris } = opts;
  const adminIdentifier = adminResourceIdentifier(opts.issuer);
  validateResourceIdentifier(adminIdentifier);
  const feAdmin = buildFeAdminClient(uris);
  const clients = conn.collection('clients');
  const credentials = conn.collection('clientcredentials');

  // Confused-deputy guard: printed before any read or write.
  await io.write(`target: ${conn.host}:${conn.port}/${conn.name}`);
  await assertReplicaSet(conn);
  await assertUniqueIndexes(conn);

  // Generated once, outside the (retryable) callback; used only if this run issues a credential.
  const secret = generateToken();
  const secretHash = await hashPassword(secret);

  type TxnResult = Omit<Extract<BootstrapResult, { status: 'ok' }>, 'status' | 'usableSuperAdmins'>;
  const write = async (session: ClientSession): Promise<TxnResult> => {
    await io.beforeTouch?.();
    // D88.6: serializes two bootstrap runs (write conflict on this one document).
    await conn
      .collection('opslocks')
      .updateOne({ _id: 'bootstrap' as never }, { $inc: { n: 1 } }, { upsert: true, session });

    const existing = await clients.findOne<ClientRow>(
      { clientId: FE_ADMIN_CLIENT_ID },
      { session, projection: { _id: 0 } },
    );
    let urisUpdated = false;
    if (existing) {
      if (!isAdminCapableClient(existing as never)) {
        throw new Refusal(
          `client ${FE_ADMIN_CLIENT_ID} exists but is not admin-capable (confidential + ` +
            'client_secret_basic/post): fix or delete it first; nothing was written',
        );
      }
      const drift =
        !sameList(existing.redirectUris, uris.redirectUris) ||
        !sameList(existing.postLogoutRedirectUris, uris.postLogoutRedirectUris);
      if (drift && !args.updateUris) {
        throw new Drift(
          {
            redirectUris: existing.redirectUris ?? [],
            postLogoutRedirectUris: existing.postLogoutRedirectUris ?? [],
          },
          uris,
        );
      }
      urisUpdated = drift;
    }

    const created = await ensureAdminPlane(
      conn,
      { issuer: opts.issuer, feAdmin, label: 'bootstrap' },
      session,
    );
    const at = now();
    const audits: AuditEvent[] = [];
    const base = {
      actorType: 'system' as const,
      actorId: args.operator,
      tenantId: DEFAULT_TENANT_ID,
      targetType: 'client',
      targetId: FE_ADMIN_CLIENT_ID,
      clientId: FE_ADMIN_CLIENT_ID,
      result: 'success' as const,
    };
    if (urisUpdated) {
      await clients.updateOne(
        { clientId: FE_ADMIN_CLIENT_ID },
        {
          $set: {
            redirectUris: uris.redirectUris,
            postLogoutRedirectUris: uris.postLogoutRedirectUris,
          },
        },
        { session },
      );
      audits.push({
        ...base,
        action: AuditAction.REDIRECT_URI_CHANGED,
        metadata: sanitizeMetadata({
          changedFields: 'redirectUris,postLogoutRedirectUris',
          via: 'bootstrap',
          ...(args.ticket ? { ticket: args.ticket } : {}),
        }) as AuditMetadata,
        eventId: randomUUID(),
        timestamp: at,
      });
    }

    let secretRotated = false;
    if (args.rotateSecret) {
      // D88.9: no grace — used when the first secret was lost or leaked.
      await credentials.updateMany(
        { clientId: FE_ADMIN_CLIENT_ID, revokedAt: null },
        { $set: { revokedAt: at } },
        { session },
      );
      secretRotated = true;
    }
    const active = await credentials.findOne(
      {
        clientId: FE_ADMIN_CLIENT_ID,
        revokedAt: null,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: at } }],
      },
      { session, projection: { _id: 1 } },
    );
    const secretIssued = active === null;
    if (secretIssued) {
      const latest = await credentials.findOne<{ version: number }>(
        { clientId: FE_ADMIN_CLIENT_ID },
        { session, sort: { version: -1 }, projection: { version: 1 } },
      );
      await credentials.insertOne(
        {
          clientId: FE_ADMIN_CLIENT_ID,
          secretHash,
          version: (latest?.version ?? 0) + 1,
          createdAt: at,
          expiresAt: null,
          revokedAt: null,
        },
        { session },
      );
    }

    const event: AuditEvent = {
      ...base,
      action: AuditAction.ADMIN_BOOTSTRAPPED,
      metadata: sanitizeMetadata({
        createdTenant: created.tenant,
        createdResource: created.resource,
        createdClient: created.client,
        credentialIssued: secretIssued,
        credentialRotated: secretRotated,
        urisUpdated,
        ...(args.ticket ? { ticket: args.ticket } : {}),
        host: hostname(),
      }) as AuditMetadata,
      eventId: randomUUID(),
      timestamp: at,
    };
    audits.push(event);
    // In the transaction (D88.11): an audit failure aborts every write above.
    await conn.model('AuditLog').create(audits, { session, ordered: true });
    return { eventId: event.eventId, created, secretIssued, secretRotated, urisUpdated };
  };

  let r: TxnResult;
  let session: ClientSession | undefined;
  try {
    session = await conn.startSession();
    const s = session;
    r = await s.withTransaction(() => write(s), {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      maxCommitTimeMS: 5000,
    });
  } catch (err) {
    if (err instanceof Drift) {
      await io.write(`fe-admin URIs differ from the environment (nothing written):`);
      await io.write(`  stored redirectUris: ${err.stored.redirectUris.join(', ')}`);
      await io.write(`  env    redirectUris: ${err.wanted.redirectUris.join(', ')}`);
      await io.write(
        `  stored postLogoutRedirectUris: ${err.stored.postLogoutRedirectUris.join(', ')}`,
      );
      await io.write(
        `  env    postLogoutRedirectUris: ${err.wanted.postLogoutRedirectUris.join(', ')}`,
      );
      await io.write('re-run with --update-uris --ticket <ref> to replace the stored lists');
      return { status: 'drift' };
    }
    if (err instanceof Refusal || (err instanceof Error && /^bootstrap: /.test(err.message))) {
      throw err;
    }
    throw new Error(
      'transaction aborted, nothing was written (db:bootstrap needs a replica set or mongos): ' +
        (err instanceof Error ? err.message : 'non-Error thrown'),
      { cause: err },
    );
  } finally {
    await session?.endSession();
  }

  // After the commit only (D88.7): the secret leaves the process here, once, on stdout.
  await io.write(`tenant ${DEFAULT_TENANT_ID}: ${r.created.tenant ? 'created' : 'exists'}`);
  await io.write(`resource admin: ${r.created.resource ? 'created' : 'exists'}`);
  await io.write(`client ${FE_ADMIN_CLIENT_ID}: ${r.created.client ? 'created' : 'exists'}`);
  if (r.urisUpdated) await io.write(`client ${FE_ADMIN_CLIENT_ID}: redirect URIs updated`);
  if (r.secretIssued) {
    try {
      await io.write(`OIDC_CLIENT_SECRET=${secret}`);
    } catch {
      throw new Error(
        'the new fe-admin secret was committed but could not be printed: run db:bootstrap ' +
          '--rotate-secret --ticket <ref> to issue another one',
      );
    }
    await io.write(
      `fe-admin secret${r.secretRotated ? ' (rotated, every older one revoked)' : ''}: ` +
        'shown once, store it in the fe-admin secret store now',
    );
  } else {
    await io.write('fe-admin secret: unchanged (active credential exists)');
  }
  await io.write(
    JSON.stringify({ alert: true, action: AuditAction.ADMIN_BOOTSTRAPPED, eventId: r.eventId }),
  );
  const usable = await usableSuperAdmins(conn);
  await io.write(`usable super_admins: ${usable}`);
  if (usable === 0) {
    await io.write(
      'next: the first administrator registers at /register and verifies the email, then run ' +
        'db:admin-recover --email <email> --requested-by <a> --approved-by <b> --ticket <ref>',
    );
  }
  return { status: 'ok', ...r, usableSuperAdmins: usable };
}

async function main(): Promise<number> {
  const args = parseBootstrapArgs(process.argv);
  const env = validateEnv(process.env);
  const uris = readBootstrapEnv(process.env);
  console.log(mongoTarget(env.MONGO_URI));
  console.log(`fe-admin redirectUris: ${uris.redirectUris.join(', ')}`);
  console.log(`fe-admin postLogoutRedirectUris: ${uris.postLogoutRedirectUris.join(', ')}`);
  console.log(
    `plan: operator=${args.operator} update-uris=${args.updateUris} rotate-secret=${args.rotateSecret}`,
  );
  if (args.dryRun) {
    console.log('dry-run: no connection made');
    return 0;
  }
  const conn = await mongoose
    .createConnection(env.MONGO_URI, { autoIndex: false, serverSelectionTimeoutMS: 5000 })
    .asPromise();
  for (const { name, schema } of buildModels(env.AUDIT_RETENTION_DAYS)) {
    if (!conn.models[name]) conn.model(name, schema);
  }
  try {
    const r = await bootstrapAdminPlane(
      conn,
      { issuer: env.ISSUER, uris, args },
      {
        write: (line) =>
          new Promise<void>((resolve, reject) =>
            process.stdout.write(`${line}\n`, (err) => (err ? reject(err) : resolve())),
          ),
      },
    );
    return r.status === 'drift' ? 2 : 0;
  } finally {
    await conn.close();
  }
}

// `require` is undefined when imported under ESM (Jest); the built CLI is CJS.
if (typeof require !== 'undefined' && require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`bootstrap failed: ${cliErrorText(err, process.env.MONGO_URI)}`);
      process.exit(1);
    },
  );
}
