import type { AuditEvent } from "@/server/admin-api/schemas";

/** Text that marks a security event (never colour only); shared by `/audit` and the dashboard. */
export function alertLabel(e: AuditEvent): string | null {
  if (e.action === "TOKEN_REUSE_DETECTED") return "Security alert: token reuse";
  if (e.action === "SIGNING_KEY_ROTATED" && e.metadata?.mode === "emergency") return "Security alert: emergency key rotation";
  return null;
}
