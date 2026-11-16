import type { AuditEvent } from "@/server/admin-api/schemas";

/** Text that marks a security event (never colour only); shared by `/audit` and the dashboard. */
export function alertLabel(e: AuditEvent): string | null {
  if (e.action === "TOKEN_REUSE_DETECTED") return "Security alert: token reuse";
  if (e.action === "SIGNING_KEY_ROTATED" && e.metadata?.mode === "emergency") return "Security alert: emergency key rotation";
  // Run 89 (D89.19): the alerting second-factor events (BE `ALERT_ACTIONS`).
  // A failure is a refused reset or one whose session revoke failed (factor removed): no "reset by".
  if (e.action === "ADMIN_USER_MFA_RESET") {
    return e.result === "failure"
      ? "Security alert: two-step verification reset refused or incomplete"
      : "Security alert: two-step verification reset by an administrator";
  }
  if (e.action === "MFA_DISABLED") return "Security alert: two-step verification turned off";
  if (e.action === "AUTH_MFA_THROTTLED") return "Security alert: repeated wrong two-step verification codes";
  if (e.action === "AUTH_MFA_LOCKED") return "Security alert: two-step verification locked after wrong codes";
  return null;
}
