import { z } from "zod";

/**
 * Typed, validated environment for the SPA (plan T1). Only `VITE_*` vars are ever read —
 * those are client-exposed by design; this file MUST NOT read or bundle any secret. The app
 * is a public OIDC client (PKCE), so there is no client secret to carry.
 *
 * On a missing/invalid var `parseEnv` throws a readable error naming the offending var(s) and
 * pointing at `.env.example`, so the dev sees a real message instead of a blank screen.
 */

/** A resource indicator (RFC 8707) must be an absolute URI with no fragment (spec §7). */
const absoluteUriNoFragment = z
  .string()
  .url("must be an absolute URL")
  .refine((v) => !v.includes("#"), "must not contain a URL fragment (#...)");

export const EnvSchema = z.object({
  VITE_OIDC_ISSUER: z.string().url("must be an absolute URL (e.g. http://localhost:4000)"),
  VITE_OIDC_CLIENT_ID: z.string().min(1, "must not be empty"),
  VITE_OIDC_REDIRECT_URI: z.string().url("must be an absolute URL"),
  VITE_OIDC_POST_LOGOUT_URI: z.string().url("must be an absolute URL"),
  VITE_OIDC_SCOPE: z
    .string()
    .min(1, "must not be empty")
    .refine((v) => v.split(/\s+/).includes("openid"), "must include the \"openid\" scope"),
  VITE_OIDC_RESOURCE: absoluteUriNoFragment,
  VITE_DEMO_API_URL: z.string().url("must be an absolute URL"),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Parse a raw env record (usually `import.meta.env`) into a typed `Env`. Throws an `Error`
 * whose message lists every missing/invalid var plus a `cp .env.example .env` hint. Pure and
 * injectable so tests can pass any record without touching `import.meta.env`.
 */
export function parseEnv(raw: Record<string, unknown>): Env {
  const result = EnvSchema.safeParse(raw);
  if (result.success) return result.data;

  const lines = result.error.issues.map((i) => {
    const name = i.path.join(".") || "(root)";
    return `  - ${name}: ${i.message}`;
  });
  throw new Error(
    [
      "Invalid or missing environment variables for fe-sso-test:",
      ...lines,
      "",
      "Copy the template and fill it in:  cp .env.example .env",
    ].join("\n"),
  );
}
