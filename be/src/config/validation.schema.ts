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

export const envSchema = z
  .object({
    // Required, no default (DEBT-098, Q-26.3): an unset NODE_ENV must not silently mean `development`
    // (fail-open: demo surface, http localhost URIs, insecure cookies). Missing => app does not boot.
    NODE_ENV: z.enum(['development', 'test', 'production']),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    ISSUER: z.string().url(),

    MONGO_URI: z.string().min(1),
    REDIS_URL: z.string().min(1),
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

    KEY_PROVIDER: z.enum(['local', 'aws-kms', 'vault']).default('local'),
    KEY_LOCAL_DIR: z.string().min(1),

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
    if (env.NODE_ENV === 'production' && !env.SESSION_COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_COOKIE_SECURE'],
        message: 'SESSION_COOKIE_SECURE=false is not allowed when NODE_ENV=production',
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
