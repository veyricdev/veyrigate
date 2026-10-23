import { z } from "zod";
import {
  RESOURCE_ID,
  RESOURCE_IDENTIFIER_MAX_LEN,
  RESOURCE_SCOPES_MAX,
  RESOURCE_SCOPE_MAX_LEN,
} from "@/features/admin-api/inputs";

/**
 * Resource form rules (run 46 A6.2): a mirror of the BE (`CreateResourceDto` / `UpdateResourceDto`
 * in `be/src/modules/admin/admin.dto.ts`, `validateResourceFormat` in
 * `be/src/modules/resources/resource.validator.ts`). Stricter than the BE only for leading/trailing
 * spaces in `identifier` (DEBT-324) and duplicate scopes. The BE stays the enforcement point.
 */

/** Text kept for a step-up draft (50 scopes of 256 + separators fit). */
const TEXT_MAX = 16_000;

/** Why the BE would refuse `v` as a resource `identifier` (the `aud`), checked in this order. */
export function identifierProblem(v: string): string | null {
  if (v === "") return "Required";
  if (v.length > RESOURCE_IDENTIFIER_MAX_LEN) return `Must be at most ${RESOURCE_IDENTIFIER_MAX_LEN} characters`;
  // `new URL` ignores them but the BE stores the raw string: the `aud` would never match.
  if (v !== v.trim()) return "Remove leading/trailing spaces";
  if (!URL.canParse(v)) return "Must be an absolute URI";
  if (new URL(v).hash !== "") return "Must not contain a fragment";
  return null;
}

/** Scope tokens of the textarea (split on spaces / new lines). */
export const scopeList = (text: string) => text.split(/\s+/).filter(Boolean);

/** Space- or line-separated resource scopes (≤ 50, each ≤ 256, no duplicate). Output: the list. */
const scopesText = z
  .string()
  .superRefine((text, ctx) => {
    const tokens = scopeList(text);
    if (tokens.length > RESOURCE_SCOPES_MAX) ctx.addIssue({ code: "custom", message: `At most ${RESOURCE_SCOPES_MAX} scopes` });
    if (tokens.some((t) => t.length > RESOURCE_SCOPE_MAX_LEN)) {
      ctx.addIssue({ code: "custom", message: `A scope must be at most ${RESOURCE_SCOPE_MAX_LEN} characters` });
    }
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
export const EditResourceDraftSchema = z.object({ scopes: z.string().max(TEXT_MAX) });
export type EditResourceValues = z.infer<typeof EditResourceDraftSchema>;

/** Same scopes, same order (the PATCH replaces the list as sent). */
export const sameScopes = (a: string, b: string) => JSON.stringify(scopeList(a)) === JSON.stringify(scopeList(b));
