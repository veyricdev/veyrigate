import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ConfirmAction, outcomeOf, useActionNotice, type ActionOutcome } from "@/components/feedback/confirm-action";
import { useSetUserRoles } from "@/features/admin-api/hooks";
import { ADMIN_ROLES, type SetUserRolesParams } from "@/features/admin-api/inputs";
import { adminKeys } from "@/features/admin-api/keys";
import { AdminRequestError } from "@/features/admin-api/types";
import { USER_GONE } from "@/features/users/user-account";
import type { Viewer } from "@/features/auth/viewer-types";
import type { AdminUser } from "@/server/admin-api/schemas";

type AdminRole = SetUserRolesParams["roles"][number];

const ROLE_INFO: Record<AdminRole, { label: string; hint: string }> = {
  tenant_admin: { label: "Tenant admin", hint: "Administers this tenant: its users, sessions, clients and audit." },
  super_admin: { label: "Super admin", hint: "Administers every tenant, every resource and the signing keys." },
};

/**
 * UX gate (the BE decides, run 69): nobody changes their own roles; only a super admin grants,
 * removes or touches `super_admin`. A tenant_admin MAY change the `tenant_admin` role of another
 * tenant_admin (not `accountGate().protectedTarget`, the lock gate).
 */
export function rolesGate(viewer: Viewer, user: AdminUser, writable: boolean) {
  const self = user.id.toLowerCase() === viewer.sub.toLowerCase();
  const viewerSuper = viewer.roles.includes("super_admin");
  return {
    self,
    canEdit: writable && !self && (viewerSuper || !user.roles.includes("super_admin")),
    showSuper: viewerSuper,
  };
}

const BY_CODE = {
  forbidden:
    "You cannot make this change: only a super admin can grant or remove super admin or change a super admin, and nobody can change their own roles.",
  conflict: "Not changed: the tenant must keep at least one active super admin.",
  invalid_request: "The roles were rejected. Reload the page and try again.",
};
export const ROLES_DONE = "Roles updated. They apply on the user's next request.";
export const ROLES_UNCERTAIN =
  "The roles may not have been changed. The current roles are shown below; check them before trying again.";

interface Props {
  user: AdminUser;
  viewer: Viewer;
  path: string;
  /** False after the user turned out `not_found` (DEBT-320): no form. */
  writable: boolean;
}

/** Admin roles of the membership (A6.3b): `PATCH /admin/users/{id}/roles` behind a confirmation. */
export function UserRoles({ user, viewer, path, writable }: Props) {
  const { notice, headingRef, announce } = useActionNotice();
  const { self, canEdit, showSuper } = rolesGate(viewer, user, writable);
  const current = ADMIN_ROLES.filter((r) => user.roles.includes(r));
  return (
    <section aria-labelledby="roles-title" className="space-y-3">
      <h2 id="roles-title" ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
        Admin roles
      </h2>
      <p role="status" className="text-sm">
        {notice}
      </p>
      {writable && self && <p className="text-sm text-muted-foreground">You cannot change your own roles.</p>}
      {writable && !self && !canEdit && (
        <p className="text-sm text-muted-foreground">Only a super admin can change the roles of a super admin.</p>
      )}
      {/* A new server value remounts the form: the draft never drifts from its base. */}
      {canEdit && <RolesForm key={current.join(",")} user={user} current={current} showSuper={showSuper} path={path} onDone={announce} />}
    </section>
  );
}

/**
 * The draft of the admin roles and its save. `step_up_required` keeps no intent: after confirming
 * their identity the admin ticks the boxes again (accepted, run 70).
 */
function RolesForm({
  user,
  current,
  showSuper,
  path,
  onDone,
}: {
  user: AdminUser;
  current: AdminRole[];
  showSuper: boolean;
  path: string;
  onDone: (message: string) => void;
}) {
  const setRoles = useSetUserRoles();
  const queryClient = useQueryClient();
  const id = useId();
  const [draft, setDraft] = useState<AdminRole[]>(current);
  // Fixed order; only admin roles (the BE keeps every other role, DEBT-149).
  const target = ADMIN_ROLES.filter((r) => draft.includes(r));
  const grant = target.filter((r) => !current.includes(r));
  const remove = current.filter((r) => !target.includes(r));
  const shown = showSuper ? ADMIN_ROLES : (["tenant_admin"] as const);
  const names = (roles: AdminRole[]) => roles.map((r) => ROLE_INFO[r].label).join(", ");

  async function save(): Promise<ActionOutcome> {
    try {
      await setRoles.mutateAsync({ userId: user.id, roles: target });
      return { done: ROLES_DONE };
    } catch (err) {
      // Never re-sent: an unknown outcome closes the dialog and the data is re-read.
      if (!(err instanceof AdminRequestError) || err.uncertain) return { done: ROLES_UNCERTAIN };
      if (err.code !== "not_found") return outcomeOf(err, ROLES_UNCERTAIN, BY_CODE);
      void queryClient.invalidateQueries({ queryKey: adminKeys.users.all });
      return { done: USER_GONE };
    }
  }

  return (
    <div className="space-y-3">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Admin roles</legend>
        {shown.map((role) => (
          <div key={role} className="space-y-0.5">
            <div className="flex items-center gap-2 text-sm">
              <input
                id={`${id}-${role}`}
                type="checkbox"
                className="size-4"
                checked={draft.includes(role)}
                aria-describedby={`${id}-${role}-hint`}
                onChange={(e) => setDraft((d) => (e.target.checked ? [...d, role] : d.filter((r) => r !== role)))}
              />
              <label htmlFor={`${id}-${role}`} className="font-medium">
                {ROLE_INFO[role].label}
              </label>
            </div>
            <p id={`${id}-${role}-hint`} className="pl-6 text-xs text-muted-foreground">
              {ROLE_INFO[role].hint}
            </p>
          </div>
        ))}
      </fieldset>
      {(grant.length > 0 || remove.length > 0) && (
        <ConfirmAction
          trigger="Save roles"
          title="Change the admin roles of this user?"
          confirmLabel="Change roles"
          destructive={grant.includes("super_admin")}
          path={path}
          warning={
            grant.includes("super_admin") && (
              <p role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-destructive">
                Super admin can manage every tenant, every resource and the signing keys.
              </p>
            )
          }
          run={save}
          onDone={onDone}
        >
          {grant.length > 0 && <p>Grant: {names(grant)}</p>}
          {remove.length > 0 && <p>Remove: {names(remove)}</p>}
          {remove.includes("super_admin") && <p>The tenant must keep at least one active super admin.</p>}
        </ConfirmAction>
      )}
    </div>
  );
}
