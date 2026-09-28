import { z } from 'zod';

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

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  ISSUER: z.string().url(),

  MONGO_URI: z.string().min(1),
  REDIS_URL: z.string().min(1),

  ACCESS_TOKEN_TTL: positiveInt,
  REFRESH_TOKEN_TTL: positiveInt,
  SESSION_IDLE_TTL: positiveInt,
  SESSION_ABSOLUTE_TTL: positiveInt,

  KEY_PROVIDER: z.enum(['local', 'aws-kms', 'vault']).default('local'),
  KEY_LOCAL_DIR: z.string().min(1),

  SMTP_URL: z.string().min(1),

  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),

  ADMIN_SEED_EMAIL: z.string().email(),
  ADMIN_SEED_PASSWORD: z.string().min(1),

  CSRF_SECRET: z.string().min(1),

  RATE_LIMIT_WINDOW: positiveInt,
  RATE_LIMIT_MAX: positiveInt,
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
