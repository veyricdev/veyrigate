import { AdminRequestError } from "@/features/admin-api/types";

/** Message for a failed write; `null` for `unauthenticated` (the query client signs in again). */
export function failureMessage(err: unknown, uncertainText: string): string | null {
  if (!(err instanceof AdminRequestError)) return "Something went wrong. Please try again.";
  if (err.uncertain) return uncertainText;
  if (err.code === "unauthenticated") return null;
  return err.message; // fixed text per code, or the BE 400/409 description (rendered as text)
}

/** The messages of a TanStack Form field's errors (strings or `{ message }` issues). */
export const fieldMessages = (errors: readonly unknown[]) =>
  errors
    .map((e) => (typeof e === "string" ? e : (e as { message?: unknown } | undefined)?.message))
    .filter((m): m is string => typeof m === "string");

export const textareaClass =
  "w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30";
