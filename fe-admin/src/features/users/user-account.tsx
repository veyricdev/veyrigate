import { ConfirmAction, outcomeOf, useActionNotice, type ActionOutcome } from "@/components/feedback/confirm-action";
import { useQueryClient } from "@tanstack/react-query";
import { useLockUser, useRevokeUserSessions, useUnlockUser } from "@/features/admin-api/hooks";
import { adminKeys } from "@/features/admin-api/keys";
import { signInAgain } from "@/features/admin-api/query-client";
import { AdminRequestError } from "@/features/admin-api/types";
import type { Viewer } from "@/features/auth/viewer-types";
import type { AdminUser } from "@/server/admin-api/schemas";

/**
 * Lock state as text (plan A6.3: show `lockedUntil`), dates as ISO text (no locale: same on SSR and
 * hydration). An admin lock is `lockedUntil` in year 9999 (BE `ADMIN_LOCKED_UNTIL`, DEBT-336); any
 * other lock is the short one after failed sign-ins. A past `lockedUntil` is not a lock (`locked`).
 */
export function lockStatus(user: Pick<AdminUser, "locked" | "lockedUntil">): string {
  if (!user.locked) return "Not locked";
  if (user.lockedUntil === null || new Date(user.lockedUntil).getUTCFullYear() >= 9999) {
    return "Locked by an administrator (until unlocked)";
  }
  return `Temporarily locked after failed sign-ins until ${user.lockedUntil}`;
}

const ADMIN_ROLES = ["tenant_admin", "super_admin"];

/**
 * UX gate (the BE decides): `self` = the viewer's own account (no Lock); `protectedTarget` = a
 * tenant_admin looking at an admin account (the BE refuses lock/unlock/revoke-all: 403).
 */
export function accountGate(viewer: Viewer, user: AdminUser) {
  return {
    self: user.id.toLowerCase() === viewer.sub.toLowerCase(),
    protectedTarget: !viewer.roles.includes("super_admin") && user.roles.some((r) => ADMIN_ROLES.includes(r)),
  };
}

const BY_CODE = {
  forbidden: "Only a super admin can change this account: it holds an admin role or belongs to another tenant.",
  not_found: "This user no longer exists in this tenant.",
};

export const LOCK_UNCERTAIN =
  'The lock may not have been applied, or sessions may not all have ended. The current state is shown below; if the account shows as locked, use "Revoke all sessions" to make sure.';
export const UNLOCK_UNCERTAIN = "The unlock may not have been applied. The current state is shown below; check it before trying again.";
export const REVOKE_ALL_UNCERTAIN = "The outcome is unknown; the data was reloaded. Running it again is safe.";

interface Props {
  user: AdminUser;
  viewer: Viewer;
  path: string;
  /** False after the user turned out `not_found` (DEBT-320): facts only, no write. */
  writable: boolean;
}

/**
 * Account facts + the GLOBAL account writes (run 47 F3/F4): lock, unlock, revoke every session.
 * Nothing is ever re-sent by itself; an unknown lock/unlock outcome closes the dialog and is
 * reported here (DEBT-313: no confirm button whose next click may repeat it).
 */
export function UserAccount({ user, viewer, path, writable }: Props) {
  const lock = useLockUser();
  const unlock = useUnlockUser();
  const revokeAll = useRevokeUserSessions();
  const queryClient = useQueryClient();
  const { notice, headingRef, announce } = useActionNotice();
  const { self, protectedTarget } = accountGate(viewer, user);
  const canWrite = writable && !protectedTarget;

  /** A known refusal changed nothing; `not_found` still re-reads, so the writes go (DEBT-320). */
  function refused(err: AdminRequestError, uncertainText: string): ActionOutcome {
    if (err.code !== "not_found") return outcomeOf(err, uncertainText, BY_CODE);
    void queryClient.invalidateQueries({ queryKey: adminKeys.users.all });
    return { done: BY_CODE.not_found };
  }

  async function setLocked(next: boolean): Promise<ActionOutcome> {
    try {
      await (next ? lock : unlock).mutateAsync(user.id);
      return { done: next ? "Account locked. Every session and refresh token was ended." : "Account unlocked." };
    } catch (err) {
      const uncertain = next ? LOCK_UNCERTAIN : UNLOCK_UNCERTAIN;
      if (!(err instanceof AdminRequestError) || err.uncertain) return { done: uncertain };
      return refused(err, uncertain);
    }
  }

  async function revokeSessions(): Promise<ActionOutcome> {
    try {
      await revokeAll.mutateAsync(user.id);
    } catch (err) {
      // idempotent: an unknown outcome keeps the dialog, running it again is safe
      if (!(err instanceof AdminRequestError) || err.uncertain) return outcomeOf(err, REVOKE_ALL_UNCERTAIN);
      return refused(err, REVOKE_ALL_UNCERTAIN);
    }
    if (self) {
      signInAgain(); // this console's own session just ended
      return { done: "" };
    }
    return { done: "Every session and refresh token of this account was ended." };
  }

  const facts: [string, string][] = [
    ["Email", user.email],
    ["User ID", user.id],
    ["Email verified", user.emailVerified ? "Yes" : "No"],
    ["Membership", user.membershipStatus],
    ["Roles", user.roles.length ? user.roles.join(", ") : "—"],
    ["Created", user.createdAt ?? "—"],
    ["Lock", lockStatus(user)],
  ];

  return (
    <section aria-labelledby="account-title" className="space-y-3">
      <h2 id="account-title" ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
        Account
      </h2>
      <dl className="grid max-w-2xl grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
        {facts.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="font-mono break-all">{value}</dd>
          </div>
        ))}
      </dl>
      <p role="status" className="text-sm">
        {notice}
      </p>
      {writable && protectedTarget && <p className="text-sm text-muted-foreground">Only a super admin can change this account.</p>}
      {canWrite && self && <p className="text-sm text-muted-foreground">You cannot lock your own account.</p>}
      {canWrite && (
        <div className="flex flex-wrap gap-2">
          {/* One instance per action (`key`): a state change never turns an open Lock into Unlock. */}
          {user.locked ? (
            <ConfirmAction
              key="unlock"
              trigger="Unlock"
              title="Unlock this account?"
              confirmLabel="Unlock"
              path={path}
              run={() => setLocked(false)}
              onDone={announce}
            >
              <p>The user can sign in again, in every tenant. The failed sign-in counter is cleared.</p>
              <p>Sessions and refresh tokens ended by the lock are not restored.</p>
            </ConfirmAction>
          ) : (
            !self && (
              <ConfirmAction
                key="lock"
                trigger="Lock"
                title="Lock this account?"
                confirmLabel="Lock account"
                destructive
                path={path}
                run={() => setLocked(true)}
                onDone={announce}
              >
                <p>
                  The account is locked everywhere (every tenant, every application) until an administrator unlocks it.
                </p>
                <p>Every session and refresh token of the user, in every application, ends immediately.</p>
              </ConfirmAction>
            )
          )}
          <ConfirmAction
            trigger="Revoke all sessions"
            title="Revoke every session of this account?"
            confirmLabel="Revoke all sessions"
            destructive
            path={path}
            warning={
              self && (
                <p role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-destructive">
                  This is your own account: you will be signed out of this console and every other application immediately.
                </p>
              )
            }
            run={revokeSessions}
            onDone={announce}
          >
            <p>
              Ends every sign-in session and every refresh token of this user in every application and every tenant, not
              only this one. Access tokens already issued stay valid until they expire.
            </p>
          </ConfirmAction>
        </div>
      )}
    </section>
  );
}
