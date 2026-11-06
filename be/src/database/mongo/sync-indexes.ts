import mongoose, { type Connection, type Model } from 'mongoose';
import { validateEnv } from '../../config/validation.schema';
import { DEFAULT_AUDIT_RETENTION_DAYS } from '../../modules/security/audit/audit-log.schema';
import { buildModels } from './models';

/**
 * Explicit index sync (B1.6). `autoIndex` is off in production, so indexes are
 * created here on purpose: `syncIndexes()` builds missing indexes and drops
 * ones no longer declared in a schema. Returns dropped index names per model.
 * `retentionDays` = `AUDIT_RETENTION_DAYS` (run 71); a model already registered on the connection
 * with another audit TTL is refused (it would make `syncIndexes()` drop + rebuild `timestamp_1`).
 */
export async function syncAllIndexes(
  connection: Connection,
  retentionDays: number = DEFAULT_AUDIT_RETENTION_DAYS,
): Promise<Record<string, string[]>> {
  const dropped: Record<string, string[]> = {};
  for (const { name, schema } of buildModels(retentionDays)) {
    const model = connection.models[name] ?? connection.model(name, schema);
    if (name === 'AuditLog') await setAuditTtlInPlace(model, retentionDays);
    dropped[name] = await model.syncIndexes();
  }
  return dropped;
}

const AUDIT_TTL_KEY = { timestamp: 1 } as const;

/**
 * Run 71 (DEBT-344): Mongoose treats another `expireAfterSeconds` as another index (drop, then
 * create: a window without the index and a full rebuild). So an existing `{timestamp: 1}` whose TTL
 * differs (or is missing) is changed IN PLACE with `collMod` first; `syncIndexes()` then sees it as
 * equal. A `collMod` error propagates (the CLI exits != 0): never a drop/recreate fallback.
 */
async function setAuditTtlInPlace(model: Model<unknown>, retentionDays: number): Promise<void> {
  const seconds = retentionDays * 86400;
  const declared = model.schema
    .indexes()
    .find(([key]) => isTtlKey(key as Record<string, unknown>))?.[1]?.expireAfterSeconds;
  if (declared !== seconds) {
    throw new Error(
      `AuditLog model is registered with expireAfterSeconds=${String(declared)}, expected ${seconds}`,
    );
  }
  const db = model.db.db!;
  const collection = model.collection.collectionName;
  if ((await db.listCollections({ name: collection }, { nameOnly: true }).toArray()).length === 0) {
    return; // fresh DB: `syncIndexes()` creates the TTL index
  }
  const existing = (await model.collection.indexes()).find((i) =>
    isTtlKey(i.key as Record<string, unknown>),
  );
  if (existing && existing.expireAfterSeconds !== seconds) {
    await db.command({
      collMod: collection,
      index: { keyPattern: AUDIT_TTL_KEY, expireAfterSeconds: seconds },
    });
  }
}

function isTtlKey(key: Record<string, unknown>): boolean {
  const entries = Object.entries(key);
  return entries.length === 1 && entries[0][0] === 'timestamp' && entries[0][1] === 1;
}

/**
 * `target: <hosts>/<db>` of a Mongo URI, never its `user:password@` nor its query string (run 40
 * F5). The DB CLIs print it BEFORE connecting: they load `be/.env` (dev `MONGO_URI`) when the
 * variable is not passed, so a mistyped override would otherwise hit the dev DB silently.
 */
export function mongoTarget(uri: string): string {
  const m = /^mongodb(?:\+srv)?:\/\/(?:[^/?#]*@)?([^/?#@]+)(?:\/([^?#]*))?/i.exec(uri);
  // Allowlist, fail closed (retry 1): an unencoded `/ ? #` in the password defeats the userinfo
  // branch, so print only a strict `host[:port]` list and a valid Mongo db name (never `@`).
  // Retry 2: an `@` left after the match is userinfo not stripped (`u:123?x@h` reads as host:port).
  if (
    !m ||
    uri.slice(m[0].length).includes('@') ||
    !HOST_LIST.test(m[1]) ||
    !DB_NAME.test(m[2] ?? '')
  ) {
    return 'target: (unparseable MONGO_URI)';
  }
  return `target: ${m[1]}/${m[2] || 'test (default)'}`;
}

const HOST = String.raw`(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?`;
const HOST_LIST = new RegExp(`^${HOST}(?:,${HOST})*$`);
/** Characters MongoDB forbids in a db name, plus `@` and `#`. */
const DB_NAME = /^[^/\\. "$*<>:|?@#\0]*$/;

async function main(): Promise<void> {
  const env = validateEnv(process.env);
  console.log(mongoTarget(env.MONGO_URI));
  const connection = await mongoose
    .createConnection(env.MONGO_URI, { autoIndex: false, serverSelectionTimeoutMS: 5000 })
    .asPromise();
  try {
    const dropped = await syncAllIndexes(connection, env.AUDIT_RETENTION_DAYS);
    for (const [name, names] of Object.entries(dropped)) {
      console.log(`${name}: synced${names.length ? `, dropped [${names.join(', ')}]` : ''}`);
    }
  } finally {
    await connection.close();
  }
}

// `require` is undefined when imported under ESM (Jest); the built CLI is CJS.
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((err: Error) => {
    console.error(`Index sync failed: ${err.message}`);
    process.exit(1);
  });
}
