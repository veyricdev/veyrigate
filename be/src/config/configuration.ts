import type { Env } from './validation.schema';

/**
 * Typed configuration (B1.2).
 *
 * Built from the validated env (see `validateEnv`). Grouped into namespaces so
 * the rest of the app reads config through `ConfigService.get('<ns>')` and never
 * touches `process.env` directly.
 *
 * ConfigModule runs `validateEnv` first, so `process.env` here is already
 * validated; `validateEnv` re-parses to recover the coerced/typed values.
 */

export interface AppConfig {
  nodeEnv: Env['NODE_ENV'];
  port: number;
  issuer: string;
}

export interface DatabaseConfig {
  mongoUri: string;
  redisUrl: string;
}

export interface TokenConfig {
  accessTokenTtl: number;
  refreshTokenTtl: number;
  sessionIdleTtl: number;
  sessionAbsoluteTtl: number;
}

export interface KeysConfig {
  provider: Env['KEY_PROVIDER'];
  localDir: string;
}

export interface FederationConfig {
  googleClientId: string;
  googleClientSecret: string;
  githubClientId: string;
  githubClientSecret: string;
}

export interface SecurityConfig {
  csrfSecret: string;
  rateLimitWindow: number;
  rateLimitMax: number;
}

export interface AdminSeedConfig {
  email: string;
  password: string;
}

export interface MailerConfig {
  smtpUrl: string;
}

export interface Config {
  app: AppConfig;
  database: DatabaseConfig;
  token: TokenConfig;
  keys: KeysConfig;
  federation: FederationConfig;
  security: SecurityConfig;
  adminSeed: AdminSeedConfig;
  mailer: MailerConfig;
}

/**
 * Map a validated env into the grouped, typed config tree.
 * Used as the single `load` factory for `ConfigModule.forRoot`.
 */
export function buildConfig(env: Env): Config {
  return {
    app: {
      nodeEnv: env.NODE_ENV,
      port: env.PORT,
      issuer: env.ISSUER,
    },
    database: {
      mongoUri: env.MONGO_URI,
      redisUrl: env.REDIS_URL,
    },
    token: {
      accessTokenTtl: env.ACCESS_TOKEN_TTL,
      refreshTokenTtl: env.REFRESH_TOKEN_TTL,
      sessionIdleTtl: env.SESSION_IDLE_TTL,
      sessionAbsoluteTtl: env.SESSION_ABSOLUTE_TTL,
    },
    keys: {
      provider: env.KEY_PROVIDER,
      localDir: env.KEY_LOCAL_DIR,
    },
    federation: {
      googleClientId: env.GOOGLE_CLIENT_ID,
      googleClientSecret: env.GOOGLE_CLIENT_SECRET,
      githubClientId: env.GITHUB_CLIENT_ID,
      githubClientSecret: env.GITHUB_CLIENT_SECRET,
    },
    security: {
      csrfSecret: env.CSRF_SECRET,
      rateLimitWindow: env.RATE_LIMIT_WINDOW,
      rateLimitMax: env.RATE_LIMIT_MAX,
    },
    adminSeed: {
      email: env.ADMIN_SEED_EMAIL,
      password: env.ADMIN_SEED_PASSWORD,
    },
    mailer: {
      smtpUrl: env.SMTP_URL,
    },
  };
}
