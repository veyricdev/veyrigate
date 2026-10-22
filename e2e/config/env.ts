/**
 * Shared E2E environment (X1). Values are hermetic, non-secret placeholders written here so the
 * suite never reads the real `be/.env` (BE loads `.env` non-overriding: `process.env` wins — see
 * `main.ts`). The dev user credential comes from `DEV_SEED_EMAIL`/`DEV_SEED_PASSWORD` (process env,
 * never hard-coded here), so no real secret lands in the repo, report, or trace.
 *
 * Isolation (tech-lead fold Q-X1-c): E2E uses its OWN Mongo db `sso-idp-e2e` and Redis db `/2` on
 * the shared local containers (`aegate-mongo`, `aegate-redis`) so it never touches dev data. No
 * FLUSH / dropDatabase anywhere.
 *
 * Credential loading (DEBT-090): the dev-user password is read from `e2e/.env` if that file exists
 * (absolute path, resolved from this module), else from process env. `process.loadEnvFile` is NOT
 * wrapped in try: an unreadable `.env` throws, while malformed lines are silently ignored by Node's
 * lenient parser — so the real guard is the required-var check below, not file parsing. Node 22 does
 * not override already-set vars, so the CI job `env:` (which sets `DEV_SEED_*`) still wins. There is
 * NO silent default password: a missing/empty `DEV_SEED_PASSWORD` fails fast (see below).
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const dotenvPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env");
if (existsSync(dotenvPath)) {
  process.loadEnvFile(dotenvPath);
}

/** Dev-user credential for the login scenario. Supplied via `e2e/.env` or process env (CI: job `env:`). */
export const DEV_SEED_EMAIL = process.env.DEV_SEED_EMAIL ?? "dev@example.com";

if (!process.env.DEV_SEED_PASSWORD) {
  throw new Error(
    "DEV_SEED_PASSWORD is required for the E2E suite but is missing/empty. Set it in e2e/.env " +
      "(copy e2e/.env.example) or export it in the environment; it must match the password used by " +
      "`pnpm -C be db:seed-dev`. There is no default password.",
  );
}
export const DEV_SEED_PASSWORD = process.env.DEV_SEED_PASSWORD;

export const ISSUER = "http://localhost:4000";
export const BE_PORT = 4000;
export const FE_PORT = 5173;
/** fe-admin BFF (run 42): fixed by the seeded `fe-admin` redirect_uri / post-logout URI. */
export const FE_ADMIN_PORT = 3000;
export const FE_ADMIN_URL = `http://localhost:${FE_ADMIN_PORT}`;

/** E2E-only datastores on the shared containers (own namespace; never flushed). */
export const E2E_MONGO_URI = "mongodb://localhost:27017/sso-idp-e2e?directConnection=true";
export const E2E_REDIS_URL = "redis://localhost:6379/2";

/**
 * Admin of the E2E stack (run 39, Q-39.1). Non-secret placeholders valid only on `sso-idp-e2e`:
 * `pnpm -C be seed:e2e-admin` (BE webServer) resets the admin password/lock and gives `fe-admin` a
 * credential for `E2E_FE_ADMIN_SECRET` (refuses unless NODE_ENV=test and DB `sso-idp-e2e`). Tests
 * use them to obtain an admin token through the real `fe-admin` OAuth flow (`client_secret_basic`).
 */
export const ADMIN_SEED_EMAIL = "admin@example.com";
export const ADMIN_SEED_PASSWORD = "e2e-admin-password";
export const E2E_FE_ADMIN_SECRET = "e2e-fe-admin-secret-0123456789abcdef0123456789abcdef";

/**
 * Full BE env for the E2E run. Includes every var `envSchema` requires (no defaults) plus
 * `SESSION_COOKIE_SECURE=false` (http) and `NODE_ENV=test` (not production, so the cookie-secure
 * guard and the seed`s production block both allow the run). Federation/admin/CSRF values are
 * non-secret placeholders. `DEV_SEED_*` is passed through for the seed step; it must differ from
 * `ADMIN_SEED_EMAIL`.
 */
export function beEnv(): Record<string, string> {
  return {
    NODE_ENV: "test",
    PORT: String(BE_PORT),
    ISSUER,
    MONGO_URI: E2E_MONGO_URI,
    REDIS_URL: E2E_REDIS_URL,
    REDIS_COMMAND_TIMEOUT_MS: "1000",
    ACCESS_TOKEN_TTL: "900",
    REFRESH_TOKEN_TTL: "2592000",
    SESSION_IDLE_TTL: "28800",
    SESSION_ABSOLUTE_TTL: "2592000",
    CLIENT_SECRET_GRACE_TTL: "604800",
    SESSION_COOKIE_SECURE: "false",
    KEY_PROVIDER: "local",
    // DEBT-091: absolute path to an E2E-only keyset dir. BE runs `node dist/main.js` with cwd=be/,
    // so a relative "./keys" would resolve to be/keys and overwrite/prune the dev keyset. Use an
    // absolute dir under e2e/ (git-ignored) that LocalKeyProvider.init() auto-creates.
    KEY_LOCAL_DIR: resolve(dirname(fileURLToPath(import.meta.url)), "..", ".keys"),
    SMTP_URL: "smtp://localhost:1025",
    // Run 32 (F4): federation providers are optional; empty = disabled. Set explicitly (not omitted)
    // so BE does not fall back to be/.env values (loaded non-overriding). E2E never calls real providers.
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    GITHUB_CLIENT_ID: "",
    GITHUB_CLIENT_SECRET: "",
    ADMIN_SEED_EMAIL,
    ADMIN_SEED_PASSWORD,
    E2E_FE_ADMIN_SECRET,
    CSRF_SECRET: "e2e-csrf-secret-0123456789abcdef0123456789abcdef",
    RATE_LIMIT_WINDOW: "60",
    RATE_LIMIT_MAX: "1000",
    CLIENT_AUTH_FAIL_IP_MAX: "1000",
    CLIENT_AUTH_FAIL_CLIENT_MAX: "1000",
    CONSENT_POLICY_VERSION: "1",
    CONSENT_TERMS_VERSION: "1",
    DEV_SEED_EMAIL,
    DEV_SEED_PASSWORD,
  };
}

/** VITE_* for the fe-sso-test dev server (no `.env` file in that package). */
export function feEnv(): Record<string, string> {
  return {
    VITE_OIDC_ISSUER: ISSUER,
    VITE_OIDC_CLIENT_ID: "fe-sso-test",
    VITE_OIDC_REDIRECT_URI: `http://localhost:${FE_PORT}/callback`,
    VITE_OIDC_POST_LOGOUT_URI: `http://localhost:${FE_PORT}/`,
    VITE_OIDC_SCOPE: "openid profile email offline_access",
    VITE_OIDC_RESOURCE: `${ISSUER}/demo/`,
    VITE_DEMO_API_URL: `${ISSUER}/demo/me`,
  };
}

/**
 * Server env for the fe-admin dev server (run 42). Hermetic like the BE: the real `fe-admin/.env`
 * is never relied on. Sessions go to the E2E Redis db `/2` under the `fea:` prefix (never flushed);
 * the client secret is the one `seed:e2e-admin` gives `fe-admin`. Non-secret placeholders.
 */
export function feAdminEnv(): Record<string, string> {
  return {
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: "fe-admin",
    OIDC_CLIENT_SECRET: E2E_FE_ADMIN_SECRET,
    SESSION_SECRET: "e2e-fe-admin-session-secret-0123456789abcdef",
    SESSION_REDIS_URL: E2E_REDIS_URL,
    ADMIN_API_BASE_URL: ISSUER,
    ADMIN_API_RESOURCE: `${ISSUER}/admin/`,
    APP_URL: FE_ADMIN_URL,
  };
}
