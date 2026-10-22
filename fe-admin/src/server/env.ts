// Server-only env (plan §1.4, A2). Never import from route/component code: the marker below makes
// Start's import protection fail the client build if anything client-side pulls this module in,
// and `pnpm check:bundle` scans the client assets for the variable names as a second net.
import "@tanstack/react-start/server-only";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

type Source = Record<string, string | undefined>;

// Custom messages on purpose: the validation error is logged, so it must never echo the received
// value (secrets). Only variable names + these fixed messages reach the log.
const required = { error: "is required" };
const url = () => z.url({ error: "must be a valid URL" });
const httpsUrl = () =>
  z.url({ error: "must be a valid https URL", protocol: /^https$/ });
const secret = () => z.string(required).min(32, { error: "must be at least 32 characters" });

function schema(production: boolean) {
  const publicUrl = production ? httpsUrl : url;
  return {
    OIDC_ISSUER: publicUrl(),
    OIDC_CLIENT_ID: z.string(required).min(1, required),
    OIDC_CLIENT_SECRET: secret(),
    // Q-41.3: only reserved for A4; the session store is decided there (DEBT-265).
    SESSION_SECRET: secret(),
    ADMIN_API_BASE_URL: publicUrl(),
    // Resource indicator (RFC 8707) the admin API access token is minted for.
    ADMIN_API_RESOURCE: url(),
    // Bare origin: redirect URIs are built from it, so no path and no trailing slash.
    APP_URL: publicUrl().refine((v) => URL.canParse(v) && new URL(v).origin === v, {
      error: "must be an origin without path or trailing slash",
    }),
  };
}

export type ServerEnv = ReturnType<typeof parseServerEnv>;

/** Validates `source` (copied, never mutated). Throws an error that names variables only. */
export function parseServerEnv(source: Source) {
  return createEnv({
    server: schema(source.NODE_ENV === "production"),
    runtimeEnv: { ...source },
    emptyStringAsUndefined: true,
    onValidationError: (issues) => {
      const lines = issues.map((i) => {
        const key = i.path?.map((p) => (typeof p === "object" ? p.key : p)).join(".") ?? "?";
        return `  - ${String(key)}: ${i.message}`;
      });
      const message = `Invalid server environment variables:\n${lines.join("\n")}`;
      console.error(message);
      throw new Error(message);
    },
  });
}

let cached: ServerEnv | undefined;

/** The single accessor for server env (validated once, from process.env). */
export function serverEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}
