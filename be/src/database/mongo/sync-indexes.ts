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

async function main(): Promise<void> {
  const env = validateEnv(process.env);
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
