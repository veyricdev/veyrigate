import mongoose, { type Connection } from 'mongoose';
import { validateEnv } from '../../config/validation.schema';
import { MODELS } from './models';

/**
 * Explicit index sync (B1.6). `autoIndex` is off in production, so indexes are
 * created here on purpose: `syncIndexes()` builds missing indexes and drops
 * ones no longer declared in a schema. Returns dropped index names per model.
 */
export async function syncAllIndexes(connection: Connection): Promise<Record<string, string[]>> {
  const dropped: Record<string, string[]> = {};
  for (const { name, schema } of MODELS) {
    const model = connection.models[name] ?? connection.model(name, schema);
    dropped[name] = await model.syncIndexes();
  }
  return dropped;
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
    const dropped = await syncAllIndexes(connection);
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
