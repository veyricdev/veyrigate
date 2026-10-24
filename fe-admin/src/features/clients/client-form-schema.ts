import { z } from "@/lib/zod";
import {
  AUTH_METHODS,
  CLIENT_TYPES,
  GRANT_TYPES,
  type CreateClientParams,
  type UpdateClientParams,
} from "@/features/admin-api/inputs";
import type { AdminClient } from "@/server/admin-api/schemas";

/**
 * Client form rules (run 44 A6.1): a mirror of the BE rules (`redirect-uri.validator.ts`,
 * `validateCorsOrigin`, `ClientFieldsDto`), never stricter except duplicates. The BE stays the
 * enforcement point; this only shows its refusals next to the field before the request.
 */

const MAX_ITEMS = 20;
const MAX_LEN = 2048;
/** Text kept for a step-up draft (one textarea: up to 20 lines of 2048 + blank lines). */
const TEXT_MAX = 64_000;

export type ClientType = (typeof CLIENT_TYPES)[number];
export type AuthMethod = (typeof AUTH_METHODS)[number];
export type GrantType = (typeof GRANT_TYPES)[number];

/** Valid auth methods per client type (BE `isValidAuthMethodFor`). */
export const METHODS_FOR: Record<ClientType, readonly AuthMethod[]> = {
  public: ["none"],
  confidential: ["client_secret_basic", "client_secret_post"],
};

export type UriKind = "redirect" | "origin";

/** Why the BE would refuse `value` (redirect / post-logout / front-channel URI, or CORS origin). */
export function uriProblem(value: string, kind: UriKind): string | null {
  if (value.includes("*")) return "must not contain a wildcard (*)";
  if (value.length > MAX_LEN) return `must be at most ${MAX_LEN} characters`;
  if (!URL.canParse(value)) return "must be an absolute URL";
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") return "must use https";
  if (url.protocol === "http:" && url.hostname !== "localhost") return "must use https (http only for localhost)";
  if (kind === "origin") {
    return url.origin === value ? null : "must be an exact origin: scheme://host[:port], no path or trailing slash";
  }
  if (url.hash) return "must not contain a fragment (#)";
  if (/[;,\s]/.test(url.host)) return "host contains an invalid character";
  return null;
}

/** Accepted by the form, but the BE refuses it in production (it decides by its environment). */
export function isHttpLocalhost(value: string): boolean {
  if (!URL.canParse(value.trim())) return false;
  const url = new URL(value.trim());
  return url.protocol === "http:" && url.hostname === "localhost";
}

/** True when any line of `text` is an `http://localhost` URI. */
export const hasHttpLocalhost = (text: string) => text.split("\n").some(isHttpLocalhost);

/** Non-blank lines of a textarea (trimmed), with their 1-based line number. */
function lines(text: string): { value: string; line: number }[] {
  return text
    .split("\n")
    .map((raw, i) => ({ value: raw.trim(), line: i + 1 }))
    .filter((e) => e.value !== "");
}

/** One URI per line; blank lines are ignored (never sent). Output: the list. */
const uriLines = (kind: UriKind) =>
  z
    .string()
    .superRefine((text, ctx) => {
      const items = lines(text);
      if (items.length > MAX_ITEMS) ctx.addIssue({ code: "custom", message: `At most ${MAX_ITEMS} entries` });
      const seen = new Set<string>();
      for (const { value, line } of items) {
        const problem = uriProblem(value, kind) ?? (seen.has(value) ? "is listed twice" : null);
        seen.add(value);
        if (problem) ctx.addIssue({ code: "custom", message: `Line ${line}: ${problem}` });
      }
    })
    .transform((text) => lines(text).map((e) => e.value));

/** Empty = none. */
const optionalUri = z
  .string()
  .superRefine((text, ctx) => {
    const problem = text.trim() && uriProblem(text.trim(), "redirect");
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  })
  .transform((text) => text.trim() || null);

/** Space- or line-separated scope tokens (BE: non-empty, no whitespace). */
const scopeTokens = z
  .string()
  .superRefine((text, ctx) => {
    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length > MAX_ITEMS) ctx.addIssue({ code: "custom", message: `At most ${MAX_ITEMS} scopes` });
    const long = tokens.find((t) => t.length > MAX_LEN);
    if (long) ctx.addIssue({ code: "custom", message: `A scope must be at most ${MAX_LEN} characters` });
    const dup = tokens.find((t, i) => tokens.indexOf(t) !== i);
    if (dup) ctx.addIssue({ code: "custom", message: `"${dup}" is listed twice` });
  })
  .transform((text) => text.split(/\s+/).filter(Boolean));

/** Validation of the editable fields (TanStack Form validator; its output is the request data). */
export const ClientFieldsSchema = z.object({
  grantTypes: z.array(z.enum(GRANT_TYPES)),
  redirectUris: uriLines("redirect"),
  postLogoutRedirectUris: uriLines("redirect"),
  frontchannelLogoutUri: optionalUri,
  allowedCorsOrigins: uriLines("origin"),
  allowedResources: z.array(z.string().max(MAX_LEN)).max(MAX_ITEMS, `At most ${MAX_ITEMS} resources`),
  scopes: scopeTokens,
});

/**
 * What the form holds, and the step-up draft allowlist: only the editable fields (no client id,
 * type or auth method on edit; never a secret). Unknown keys are stripped on save and restore.
 */
export const ClientDraftSchema = z.object({
  grantTypes: z.array(z.enum(GRANT_TYPES)).max(GRANT_TYPES.length),
  redirectUris: z.string().max(TEXT_MAX),
  postLogoutRedirectUris: z.string().max(TEXT_MAX),
  frontchannelLogoutUri: z.string().max(TEXT_MAX),
  allowedCorsOrigins: z.string().max(TEXT_MAX),
  allowedResources: z.array(z.string().max(MAX_LEN)).max(100),
  scopes: z.string().max(TEXT_MAX),
});
export type ClientFormValues = z.infer<typeof ClientDraftSchema>;

/**
 * Edit draft: only the fields the admin changed, so that coming back from a step-up re-applies
 * them on top of the fresh server data instead of overwriting someone else's newer values.
 */
export const EditDraftSchema = ClientDraftSchema.partial();

/**
 * The fields of `values` that differ from `base` (arrays compared whole), plus the `unknown` ones:
 * their server value is unknown (an `uncertain` PATCH, DEBT-330), so they are sent even when equal.
 */
export function changedValues(
  values: ClientFormValues,
  base: ClientFormValues,
  unknown: ReadonlySet<string> = new Set(),
): Partial<ClientFormValues> {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([key, v]) => unknown.has(key) || JSON.stringify(v) !== JSON.stringify(base[key as keyof ClientFormValues]),
    ),
  );
}

/** Create draft: the editable fields plus the (create-only) type and auth method. */
export const NewClientDraftSchema = ClientDraftSchema.extend({
  clientType: z.enum(CLIENT_TYPES),
  tokenEndpointAuthMethod: z.enum(AUTH_METHODS),
});
export type NewClientDraft = z.infer<typeof NewClientDraftSchema>;

export const EMPTY_VALUES: ClientFormValues = {
  grantTypes: ["authorization_code"],
  redirectUris: "",
  postLogoutRedirectUris: "",
  frontchannelLogoutUri: "",
  allowedCorsOrigins: "",
  allowedResources: [],
  scopes: "",
};

/** Form values for a stored client (URIs shown as text, one per line). */
export function valuesFrom(client: AdminClient): ClientFormValues {
  return {
    grantTypes: client.grantTypes,
    redirectUris: client.redirectUris.join("\n"),
    postLogoutRedirectUris: client.postLogoutRedirectUris.join("\n"),
    frontchannelLogoutUri: client.frontchannelLogoutUri ?? "",
    allowedCorsOrigins: client.allowedCorsOrigins.join("\n"),
    allowedResources: client.allowedResources,
    scopes: client.scopes.join(" "),
  };
}

export type ClientFields = z.output<typeof ClientFieldsSchema>;

/** `POST /admin/clients` body (an empty front-channel URI is omitted). */
export function toCreateBody(type: ClientType, method: AuthMethod, fields: ClientFields): CreateClientParams {
  const { frontchannelLogoutUri, ...rest } = fields;
  return {
    clientType: type,
    tokenEndpointAuthMethod: method,
    ...rest,
    ...(frontchannelLogoutUri ? { frontchannelLogoutUri } : {}),
  };
}

/**
 * `PATCH` body: the parsed value of each field the admin changed (`changed`: the keys of
 * `changedValues(values, base)`, `base` = what the form was loaded from, NOT the latest refetch).
 * A field the admin did not touch is never sent, so a newer value saved by someone else stays.
 * Never an immutable field and never `disabled` (its own action).
 */
export function toPatch(fields: ClientFields, changed: Partial<ClientFormValues>): UpdateClientParams["patch"] {
  return Object.fromEntries(Object.keys(changed).map((key) => [key, fields[key as keyof ClientFields]]));
}
