import { parseTrustProxy } from './trust-proxy';
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
  /** Fastify `trustProxy` value parsed from `TRUST_PROXY` (DEBT-006): false | IP/CIDR list. */
  trustProxy: false | string[];
}

export interface DatabaseConfig {
  mongoUri: string;
  redisUrl: string;
  /** Per-command timeout (ms) for the shared Redis client — fail-fast bound, see DEBT-005. */
  redisCommandTimeoutMs: number;
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
  /** Client-auth failure limit per source IP (DEBT-029/039). */
  clientAuthFailIpMax: number;
  /** Client-auth failure limit per `client_id|ip` (DEBT-029/039). */
  clientAuthFailClientMax: number;
}

export interface ConsentConfig {
  policyVersion: string;
  termsVersion: string;
}

/** Only the email: the bootstrap password is read by `db:seed` alone, never kept by the app (DEBT-169). */
export interface AdminSeedConfig {
  email: string;
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
      trustProxy: parseTrustProxy(env.TRUST_PROXY),
    },
    database: {
      mongoUri: env.MONGO_URI,
      redisUrl: env.REDIS_URL,
      redisCommandTimeoutMs: env.REDIS_COMMAND_TIMEOUT_MS,
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
      clientAuthFailIpMax: env.CLIENT_AUTH_FAIL_IP_MAX,
      clientAuthFailClientMax: env.CLIENT_AUTH_FAIL_CLIENT_MAX,
    },
    adminSeed: {
      email: env.ADMIN_SEED_EMAIL,
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
