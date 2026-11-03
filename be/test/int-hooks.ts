import mongoose from 'mongoose';

/**
 * Budget for an int `beforeAll` that boots (and seeds) what a spec needs, and for the `afterAll` that
 * waits for that setup before cleaning up (DEBT-448, run 61). Measured per hook on a 28-core box:
 * idle ~1.5-2.5 s (compile ~0.3 s, init+ready ~1 s, syncAllIndexes ~0.4 s); under a 28-thread
 * busy-loop load 15-23 s (max 22.8 s, b74-tester; init+ready 7-17 s, syncAllIndexes 4-9 s). ~3x that max.
 */
export const INT_SETUP_TIMEOUT_MS = 70_000;

/** afterAll: wait for a beforeAll setup that may have outlived its hook (DEBT-448); never throws, logs why. */
export async function settled(setup: Promise<unknown> | undefined): Promise<void> {
  await setup?.catch((err: unknown) =>
    console.warn(`[int] setup failed: ${err instanceof Error ? err.message : String(err)}`),
  );
}

/** Drop one test DB; refuses a DB name not starting with `vg-int-`. */
export async function dropIntDb(uri: string): Promise<void> {
  const conn = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await conn.asPromise();
    if (!conn.name.startsWith('vg-int-')) throw new Error(`dropIntDb: refusing DB "${conn.name}"`);
    await conn.dropDatabase();
  } finally {
    await conn.close();
  }
}
