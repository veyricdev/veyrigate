import { z } from 'zod';
import { parseTrustProxy } from './trust-proxy';

/**
 * Environment validation schema (B1.2).
 *
 * Mirrors `be/.env.example` (plan §1.4). Validated fail-fast at bootstrap:
 * a missing/invalid variable stops the app before it listens, and the error
 * message names the offending variable(s).
 *
 * NOTE: TTLs are validated as positive integers (seconds) here. Final values
 * are decided in Q6 (plan §12) — this schema only guarantees shape/type.
 */

const positiveInt = z.coerce.number().int().positive();
// Optional credential (B5.1, F4): unset or empty string => undefined (provider disabled).
const optionalCredential = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));
// Optional string where an empty value means unset (run 53: Vault vars stay empty for KEY_PROVIDER=local).
const optionalNonEmpty = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

/** `host:port` / `[v6]:port` ⇒ {host, port}; null when malformed (empty host, port not 1..65535). */
function parseHostPort(value: string): { host: string; port: number } | null {
  const m = /^(?:\[([0-9A-Fa-f:.]+)\]|([^\s:[\]]+)):(\d{1,5})$/.exec(value);
  const port = m ? Number(m[3]) : 0;
  return m && port >= 1 && port <= 65535 ? { host: m[1] ?? m[2], port } : null;
}

export const envSchema = z
  .object({
    // Required, no default (DEBT-098, Q-26.3): an unset NODE_ENV must not silently mean `development`
    // (fail-open: demo surface, http localhost URIs, insecure cookies). Missing => app does not boot.
    NODE_ENV: z.enum(['development', 'test', 'production']),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    ISSUER: z.string().url(),

    MONGO_URI: z.string().min(1),
    // Redis: exactly one of REDIS_URL (standalone) or REDIS_SENTINELS (run 53c, plan §6.2; checked
    // below). Sentinel mode: `host:port` list + master name; credentials/db only in this mode
    // (standalone puts them in REDIS_URL). Redis Cluster is not supported (DEBT-013/073).
    REDIS_URL: optionalNonEmpty(z.string()),
    REDIS_SENTINELS: optionalNonEmpty(
      z.string().transform((v, ctx) => {
        const list = v.split(',').map((s) => parseHostPort(s.trim()));
        if (list.some((x) => x === null)) {
          ctx.addIssue({
            code: 'custom',
            message: 'REDIS_SENTINELS must be host:port[,host:port...]',
          });
          return z.NEVER;
        }
        return list as Array<{ host: string; port: number }>;
      }),
    ),
    REDIS_SENTINEL_MASTER: optionalNonEmpty(
      z.string().regex(/^[A-Za-z0-9._-]+$/, 'REDIS_SENTINEL_MASTER has an invalid format'),
    ),
    REDIS_SENTINEL_PASSWORD: optionalNonEmpty(z.string()),
    REDIS_USERNAME: optionalNonEmpty(z.string()),
    REDIS_PASSWORD: optionalNonEmpty(z.string()),
    REDIS_DB: optionalNonEmpty(z.coerce.number().int().nonnegative()),
    // Per-command timeout (ms) for the shared Redis client (DEBT-005). Bounds request-path Redis
    // commands (rate-limit, session liveness, tombstones) so they fail fast instead of queuing
    // forever when Redis is down/reconnecting. Kept below PING_TIMEOUT_MS (1500) so `/ready` is
    // unaffected. Max 10s guards against a misconfiguration that would reintroduce the hang.
    REDIS_COMMAND_TIMEOUT_MS: positiveInt.max(10000).default(1000),

    ACCESS_TOKEN_TTL: positiveInt,
    REFRESH_TOKEN_TTL: positiveInt,
    SESSION_IDLE_TTL: positiveInt,
    SESSION_ABSOLUTE_TTL: positiveInt,
    // Client secret rotation overlap/grace (B3.1, spec §9.3/§17 — not finalised; see C2 in
    // runs/09-B3.1-B3.4/review-techlead.md). Old ClientCredential stays valid for this long
    // after a newer version is created, so backends don't have to rotate atomically.
    CLIENT_SECRET_GRACE_TTL: positiveInt.default(604800), // 7 days, temporary pending spec §17

    // Not z.coerce.boolean(): that maps the string "false" to true.
    SESSION_COOKIE_SECURE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),

    // Signing key provider (plan D9, run 53). `local` = dev-only PEM files (forbidden in production,
    // superRefine below); `vault` = HashiCorp Vault Transit, the private key never leaves Vault.
    KEY_PROVIDER: z.enum(['local', 'vault']).default('local'),
    KEY_LOCAL_DIR: optionalNonEmpty(z.string()), // required when KEY_PROVIDER=local
    // Vault Transit (required when KEY_PROVIDER=vault). The token is read from VAULT_TOKEN_FILE
    // (Vault Agent sink): there is deliberately NO `VAULT_TOKEN` variable (env leaks via inspect/proc).
    VAULT_ADDR: optionalNonEmpty(
      z.url({ protocol: /^https?$/, error: 'VAULT_ADDR must be an http(s) URL' }),
    ),
    VAULT_TOKEN_FILE: optionalNonEmpty(z.string()),
    VAULT_TRANSIT_MOUNT: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]*(\/[a-z0-9_-]+)*$/, 'VAULT_TRANSIT_MOUNT has an invalid format')
      .default('transit'),
    VAULT_TRANSIT_KEY: optionalNonEmpty(
      z.string().regex(/^[A-Za-z0-9_-]+$/, 'VAULT_TRANSIT_KEY has an invalid format'),
    ),
    VAULT_TIMEOUT_MS: positiveInt.max(10000).default(2000),

    SMTP_URL: z.string().min(1),

    // Federation providers (B5.1, F4): optional. A provider is enabled only when BOTH its id and
    // secret are set; exactly one of the pair is a misconfiguration and fails the boot (below).
    GOOGLE_CLIENT_ID: optionalCredential,
    GOOGLE_CLIENT_SECRET: optionalCredential,
    GITHUB_CLIENT_ID: optionalCredential,
    GITHUB_CLIENT_SECRET: optionalCredential,

    ADMIN_SEED_EMAIL: z.string().email(),
    // DEBT-169: ADMIN_SEED_PASSWORD is NOT an app variable: only `db:seed` reads it (own zod,
    // 12..128), so a fresh copy of `.env.example` (empty password) still boots the app.

    CSRF_SECRET: z.string().min(1),

    RATE_LIMIT_WINDOW: positiveInt,
    RATE_LIMIT_MAX: positiveInt,

    // Client-auth failure rate limit (DEBT-029/039, spec §6.3). Counts only FAILED client
    // authentications (unknown client / wrong method / wrong secret) on /token, /revoke,
    // /introspect — a successful auth never counts, so a busy RP/RS is not throttled. Two
    // buckets: per source IP (Argon2-DoS by rotating client_id) and per `client_id|ip`
    // (brute-forcing one client's secret from one IP). Window reuses RATE_LIMIT_WINDOW.
    CLIENT_AUTH_FAIL_IP_MAX: positiveInt.default(30),
    CLIENT_AUTH_FAIL_CLIENT_MAX: positiveInt.default(10),

    // Reverse-proxy trust for `req.ip` / X-Forwarded-For (DEBT-006). Disabled by default; set to
    // the proxy IP(s)/CIDR(s) in production so per-IP rate-limit buckets see the real client IP.
    // `true` and a numeric hop count are both rejected (`true` enables IP spoofing; a number is
    // silently ignored by Fastify 5, dropping `req.ip` back to the socket IP). Kept as the raw string here;
    // validated + parsed via parseTrustProxy (superRefine below, and buildConfig).
    TRUST_PROXY: z.string().optional(),

    // Current consent policy/terms versions (B4.2). A stored consent only "covers" a request when
    // these match the versions recorded on the grant, so bumping a version forces re-consent.
    // Non-empty so an empty env can never auto-approve by matching an empty stored version.
    CONSENT_POLICY_VERSION: z.string().min(1).default('1'),
    CONSENT_TERMS_VERSION: z.string().min(1).default('1'),

    // Bearer token for `GET /metrics` (B7.2, Q-37.1). Unset/empty => the route is not registered
    // (404, fail-closed); when set it must be a long random value (>= 32 chars).
    METRICS_TOKEN: z
      .string()
      .optional()
      .transform((v) => (v ? v : undefined))
      .pipe(z.string().min(32).optional()),
  })
  .superRefine((env, ctx) => {
    if (!env.REDIS_URL === !env.REDIS_SENTINELS) {
      ctx.addIssue({
        code: 'custom',
        path: ['REDIS_URL'],
        message: env.REDIS_URL
          ? 'REDIS_URL must not be set together with REDIS_SENTINELS'
          : 'set REDIS_URL (standalone) or REDIS_SENTINELS (Sentinel)',
      });
    }
    if (env.REDIS_SENTINELS && !env.REDIS_SENTINEL_MASTER) {
      ctx.addIssue({
        code: 'custom',
        path: ['REDIS_SENTINEL_MASTER'],
        message: 'REDIS_SENTINEL_MASTER is required with REDIS_SENTINELS',
      });
    }
    if (!env.REDIS_SENTINELS) {
      for (const name of [
        'REDIS_SENTINEL_MASTER',
        'REDIS_SENTINEL_PASSWORD',
        'REDIS_USERNAME',
        'REDIS_PASSWORD',
        'REDIS_DB',
      ] as const) {
        if (env[name] !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [name],
            message: `${name} is only used with REDIS_SENTINELS (standalone: put it in REDIS_URL)`,
          });
        }
      }
    }
    if (env.NODE_ENV === 'production' && !env.SESSION_COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_COOKIE_SECURE'],
        message: 'SESSION_COOKIE_SECURE=false is not allowed when NODE_ENV=production',
      });
    }
    if (env.NODE_ENV === 'production' && env.KEY_PROVIDER !== 'vault') {
      ctx.addIssue({
        code: 'custom',
        path: ['KEY_PROVIDER'],
        message: 'KEY_PROVIDER must be vault when NODE_ENV=production (local is dev-only)',
      });
    }
    const required =
      env.KEY_PROVIDER === 'local'
        ? (['KEY_LOCAL_DIR'] as const)
        : (['VAULT_ADDR', 'VAULT_TOKEN_FILE', 'VAULT_TRANSIT_KEY'] as const);
    for (const name of required) {
      if (!env[name]) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: `${name} is required when KEY_PROVIDER=${env.KEY_PROVIDER}`,
        });
      }
    }
    if (
      env.NODE_ENV === 'production' &&
      env.KEY_PROVIDER === 'vault' &&
      env.VAULT_ADDR &&
      !env.VAULT_ADDR.startsWith('https:')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['VAULT_ADDR'],
        message: 'VAULT_ADDR must use https when NODE_ENV=production',
      });
    }
    if (env.SESSION_IDLE_TTL > env.SESSION_ABSOLUTE_TTL) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_IDLE_TTL'],
        message: 'SESSION_IDLE_TTL must be <= SESSION_ABSOLUTE_TTL',
      });
    }
    for (const [id, secret] of [
      ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
      ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
    ] as const) {
      if (!env[id] !== !env[secret]) {
        ctx.addIssue({
          code: 'custom',
          path: [env[id] ? secret : id],
          message: `${id} and ${secret} must be set together (or both left empty)`,
        });
      }
    }
    try {
      parseTrustProxy(env.TRUST_PROXY);
    } catch (err) {
      ctx.addIssue({
        code: 'custom',
        path: ['TRUST_PROXY'],
        message: err instanceof Error ? err.message : 'Invalid TRUST_PROXY',
      });
    }
  });

/** Fully-typed, validated environment. */
export type Env = z.infer<typeof envSchema>;

/**
 * Validate a raw env object. On failure, throws with a message that names each
 * invalid/missing variable (used by ConfigModule for fail-fast bootstrap).
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const path = issue.path.join('.') || '(root)';
        return `  - ${path}: ${issue.message}`;
      })
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return result.data;
}
