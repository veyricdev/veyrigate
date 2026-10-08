import type { Env } from './validation.schema';

/**
 * Typed configuration (B1.2).
 *
 * Built from the validated env (see `validateEnv`). Grouped into namespaces so
 * the rest of the app reads config through `ConfigService.get('<ns>')` and never
 * touches `process.env` directly.
 *
 * ConfigModule's single `load` factory calls `validateEnv(process.env)` once
 * and passes the typed result here.
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

export interface ClientConfig {
  /** Grace period (seconds) an older `ClientCredential` version stays valid after rotation (C2). */
  secretGraceTtl: number;
}

export interface SessionConfig {
  cookieSecure: boolean;
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

export interface ConsentConfig {
  policyVersion: string;
  termsVersion: string;
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
  session: SessionConfig;
  keys: KeysConfig;
  federation: FederationConfig;
  security: SecurityConfig;
  adminSeed: AdminSeedConfig;
  mailer: MailerConfig;
  client: ClientConfig;
  consent: ConsentConfig;
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
    session: {
      cookieSecure: env.SESSION_COOKIE_SECURE,
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
    client: {
      secretGraceTtl: env.CLIENT_SECRET_GRACE_TTL,
    },
    consent: {
      policyVersion: env.CONSENT_POLICY_VERSION,
      termsVersion: env.CONSENT_TERMS_VERSION,
    },
  };
}
