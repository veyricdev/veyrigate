import { parseEnv, type Env } from "./env";

/**
 * The validated env for the running app. Evaluated at module load so a missing/invalid `.env`
 * stops the app with `parseEnv`'s readable error instead of crashing deep in a flow. Unit tests
 * import `parseEnv` from `./env` directly and never trigger this eager read.
 */
export const env: Env = parseEnv(import.meta.env as unknown as Record<string, unknown>);
