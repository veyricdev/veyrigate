import { z } from "@/lib/zod";
import {
  RESOURCE_ID,
  RESOURCE_IDENTIFIER_MAX_LEN,
  RESOURCE_SCOPES_MAX,
  RESOURCE_SCOPE_MAX_LEN,
  SCOPE_TOKEN,
  SCOPE_TOKEN_MESSAGE,
} from "@/features/admin-api/inputs";

/**
 * Resource form rules (run 46 A6.2): a mirror of the BE (`CreateResourceDto` / `UpdateResourceDto`
 * in `be/src/modules/admin/admin.dto.ts`, `validateResourceIdentifier` in
 * `be/src/modules/resources/resource.validator.ts`). Same `identifier` rule as the BE write path
 * (`validateResourceIdentifier`, DEBT-324/329); stricter only for UTF-16 length and duplicate scopes.
 * The BE stays the enforcement point.
 */

/** Text kept for a step-up draft (50 scopes of 256 + separators fit). */
const TEXT_MAX = 16_000;

/** Control (Cc), format (Cf: ZWSP, BOM, bidi) and separator (Z) characters - the BE rule (DEBT-324/329). */
const FORBIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Z}]/u;
const ALLOWED_SCHEMES = new Set(["https:", "http:", "urn:"]);

/** Why the BE would refuse `v` as a resource `identifier` (the `aud`), checked in this order. */
export function identifierProblem(v: string): string | null {
  if (v === "") return "Required";
  if (v.length > RESOURCE_IDENTIFIER_MAX_LEN) return `Must be at most ${RESOURCE_IDENTIFIER_MAX_LEN} characters`;
  // `new URL` drops or encodes them but the BE stores the raw string: the `aud` would never match.
  if (FORBIDDEN_CHARS.test(v)) return "Must not contain spaces or control characters";
  if (!URL.canParse(v)) return "Must be an absolute URI";
  const url = new URL(v);
  if (url.hash !== "") return "Must not contain a fragment";
  if (!ALLOWED_SCHEMES.has(url.protocol)) return "Must use https, http or urn";
  return null;
}

/** Scope tokens of the textarea (split on spaces / new lines). */
export const scopeList = (text: string) => text.split(/\s+/).filter(Boolean);

/** Space- or line-separated resource scopes (≤ 50, each ≤ 256, RFC 6749 scope-token, no duplicate). Output: the list. */
const scopesText = z
  .string()
  .superRefine((text, ctx) => {
    const tokens = scopeList(text);
    if (tokens.length > RESOURCE_SCOPES_MAX) ctx.addIssue({ code: "custom", message: `At most ${RESOURCE_SCOPES_MAX} scopes` });
    if (tokens.some((t) => t.length > RESOURCE_SCOPE_MAX_LEN)) {
      ctx.addIssue({ code: "custom", message: `A scope must be at most ${RESOURCE_SCOPE_MAX_LEN} characters` });
    }
    if (tokens.some((t) => !SCOPE_TOKEN.test(t))) ctx.addIssue({ code: "custom", message: SCOPE_TOKEN_MESSAGE });
    const dup = tokens.find((t, i) => tokens.indexOf(t) !== i);
    if (dup) ctx.addIssue({ code: "custom", message: `"${dup}" is listed twice` });
  })
  .transform(scopeList);

const identifierText = z.string().superRefine((v, ctx) => {
  const problem = identifierProblem(v);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

const resourceIdText = z
  .string()
  .regex(RESOURCE_ID, "1–64 characters: lowercase letters, digits, '.', '_' or '-', starting with a letter or digit");

/** New resource: validation (output = the `POST` body). */
export const NewResourceSchema = z.object({ resourceId: resourceIdText, identifier: identifierText, scopes: scopesText });
/** Edit: only `scopes` (`resourceId` / `identifier` are immutable and never in the form). */
export const EditResourceSchema = z.object({ scopes: scopesText });

/** Step-up draft allowlists (form text; parsed again on restore). */
export const NewResourceDraftSchema = z.object({
  resourceId: z.string().max(64),
  identifier: z.string().max(RESOURCE_IDENTIFIER_MAX_LEN + 64),
  scopes: z.string().max(TEXT_MAX),
});
export type NewResourceValues = z.infer<typeof NewResourceDraftSchema>;
/** Edit draft: the form text + the scopes the form was opened with (the PATCH `expectedScopes`, DEBT-323). */
export const EditResourceDraftSchema = z.object({
  scopes: z.string().max(TEXT_MAX),
  expectedScopes: z.array(z.string().max(RESOURCE_SCOPE_MAX_LEN)).max(RESOURCE_SCOPES_MAX).optional(),
});
export type EditResourceValues = { scopes: string };

/** Same scopes, same order (the PATCH replaces the list as sent). */
export const sameScopes = (a: string, b: string) => JSON.stringify(scopeList(a)) === JSON.stringify(scopeList(b));
