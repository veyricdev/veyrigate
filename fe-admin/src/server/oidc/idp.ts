import "@tanstack/react-start/server-only";
import { z } from "@/lib/zod";
import { fetchWithTimeout, type Discovery, type FetchFn } from "./discovery";

/**
 * Calls from the BFF to the IdP / admin API (confidential client, `client_secret_basic`).
 * Every call is time-boxed and none is retried: an authorization code and a refresh token are
 * single-use (no refresh grace at the IdP, a replayed RT revokes the whole family).
 * Errors never carry response bodies (no `error_description` / token reaches a log or a page).
 */

export interface IdpConfig {
  clientId: string;
  clientSecret: string;
  adminApiBaseUrl: string;
  fetch: FetchFn;
}

export class TokenEndpointError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(`Token endpoint error: HTTP ${status}${code ? ` ${code}` : ""}`);
    this.name = "TokenEndpointError";
  }
}

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().refine((t) => t.toLowerCase() === "bearer"),
  expires_in: z.number().positive(),
  // Required for the code exchange by the caller; on refresh a missing one keeps the previous.
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
});
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

const basic = (c: IdpConfig) =>
  `Basic ${Buffer.from(`${encodeURIComponent(c.clientId)}:${encodeURIComponent(c.clientSecret)}`).toString("base64")}`;

async function tokenRequest(c: IdpConfig, d: Discovery, form: Record<string, string>): Promise<TokenResponse> {
  const res = await fetchWithTimeout(
    c.fetch,
    d.token_endpoint,
    {
      method: "POST",
      headers: { authorization: basic(c), "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
    },
    5000,
  );
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const code = (body as { error?: unknown } | null)?.error;
    throw new TokenEndpointError(res.status, typeof code === "string" ? code : undefined);
  }
  const parsed = TokenResponseSchema.safeParse(body);
  if (!parsed.success) throw new TokenEndpointError(res.status, "invalid_token_response");
  return parsed.data;
}

export function exchangeCode(
  c: IdpConfig,
  d: Discovery,
  p: { code: string; verifier: string; redirectUri: string },
): Promise<TokenResponse> {
  return tokenRequest(c, d, {
    grant_type: "authorization_code",
    code: p.code,
    code_verifier: p.verifier,
    redirect_uri: p.redirectUri,
  });
}

export function refreshGrant(c: IdpConfig, d: Discovery, refreshToken: string): Promise<TokenResponse> {
  return tokenRequest(c, d, { grant_type: "refresh_token", refresh_token: refreshToken });
}

/** RFC 7009 revocation, best-effort: never throws (the caller has already ended the session). */
export async function revokeRefreshToken(c: IdpConfig, d: Discovery, refreshToken: string): Promise<void> {
  try {
    await fetchWithTimeout(
      c.fetch,
      d.revocation_endpoint,
      {
        method: "POST",
        headers: { authorization: basic(c), "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken, token_type_hint: "refresh_token" }).toString(),
      },
      3000,
    );
  } catch {
    // eslint-disable-next-line no-console -- fixed text, nothing from the token or the IdP
    console.warn("revoke: refresh token revocation failed (best-effort)");
  }
}

const AdminMeSchema = z.object({ sub: z.string(), tenantId: z.string(), roles: z.array(z.string()) });
export type AdminMe = z.infer<typeof AdminMeSchema>;

/** `GET /admin/me`: the BE is the source of truth for roles. 403 => not an admin (null). */
export async function adminMe(c: IdpConfig, accessToken: string): Promise<AdminMe | null> {
  const res = await fetchWithTimeout(
    c.fetch,
    `${c.adminApiBaseUrl.replace(/\/+$/, "")}/admin/me`,
    { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } },
    5000,
  );
  if (res.status === 403) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    if (body?.error === "forbidden") return null;
  }
  if (!res.ok) throw new Error(`admin/me failed: HTTP ${res.status}`);
  return AdminMeSchema.parse(await res.json());
}

/** `GET /userinfo` for the email (the ID token has none). Throws on any failure. */
export async function userinfo(c: IdpConfig, d: Discovery, accessToken: string): Promise<{ sub: string; email: string | null }> {
  const res = await fetchWithTimeout(
    c.fetch,
    d.userinfo_endpoint,
    { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } },
    5000,
  );
  if (!res.ok) throw new Error(`userinfo failed: HTTP ${res.status}`);
  const body = z.object({ sub: z.string(), email: z.string().optional() }).parse(await res.json());
  return { sub: body.sub, email: body.email ?? null };
}
