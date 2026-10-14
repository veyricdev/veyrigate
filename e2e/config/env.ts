/**
 * Shared E2E environment (X1). Values are hermetic, non-secret placeholders written here so the
 * suite never reads the real `be/.env` (BE loads `.env` non-overriding: `process.env` wins — see
 * `main.ts`). The dev user credential comes from `DEV_SEED_EMAIL`/`DEV_SEED_PASSWORD` (process env,
 * never hard-coded here), so no real secret lands in the repo, report, or trace.
 *
 * Isolation (tech-lead fold Q-X1-c): E2E uses its OWN Mongo db `sso-idp-e2e` and Redis db `/2` on
 * the shared local containers (`aegate-mongo`, `aegate-redis`) so it never touches dev data. No
 * FLUSH / dropDatabase anywhere.
 */

/** Dev-user credential for the login scenario. Supplied via process env (CI: job `env:`). */
export const DEV_SEED_EMAIL = process.env.DEV_SEED_EMAIL ?? "dev@example.com";
export const DEV_SEED_PASSWORD = process.env.DEV_SEED_PASSWORD ?? "dev-password-123";

export const ISSUER = "http://localhost:4000";
export const BE_PORT = 4000;
export const FE_PORT = 5173;

/** E2E-only datastores on the shared containers (own namespace; never flushed). */
export const E2E_MONGO_URI = "mongodb://localhost:27017/sso-idp-e2e?directConnection=true";
export const E2E_REDIS_URL = "redis://localhost:6379/2";

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
    KEY_LOCAL_DIR: "./keys",
    SMTP_URL: "smtp://localhost:1025",
    GOOGLE_CLIENT_ID: "e2e-google-client-id",
    GOOGLE_CLIENT_SECRET: "e2e-google-client-secret",
    GITHUB_CLIENT_ID: "e2e-github-client-id",
    GITHUB_CLIENT_SECRET: "e2e-github-client-secret",
    ADMIN_SEED_EMAIL: "admin@example.com",
    ADMIN_SEED_PASSWORD: "e2e-admin-password",
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
