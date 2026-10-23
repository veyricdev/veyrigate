import { useUpdateClient } from "@/features/admin-api/hooks";
import { AdminRequestError } from "@/features/admin-api/types";
import { ConfirmAction, outcomeOf, useActionNotice, type ActionOutcome } from "./confirm-action";

export const SELF_DISABLE_CONFLICT =
  "This client issues the admin console's own sign-in token and cannot be disabled here.";

export const UNCERTAIN_STATUS =
  "The result is unknown. The latest data was reloaded: check the client status before trying again.";

/**
 * Disable / enable a client (run 45 A6.1b). Each is its own PATCH (`{ disabled }` alone, never mixed
 * with the Settings form). A 409 on a disable-only PATCH is the self-lockout guard (DEBT-311).
 */
export function ClientStatus({ clientId, disabled, path }: { clientId: string; disabled: boolean; path: string }) {
  const update = useUpdateClient();
  const { notice, headingRef, announce } = useActionNotice();

  async function setDisabled(next: boolean): Promise<ActionOutcome> {
    try {
      await update.mutateAsync({ clientId, patch: { disabled: next } });
      return { done: next ? "Client disabled." : "Client enabled." };
    } catch (err) {
      // DEBT-313: an unknown outcome closes the dialog (message kept here, outside it): no confirm
      // button stays on screen whose next click could undo what may already have happened.
      if (!(err instanceof AdminRequestError) || err.uncertain) return { done: UNCERTAIN_STATUS };
      return outcomeOf(err, UNCERTAIN_STATUS, next ? { conflict: SELF_DISABLE_CONFLICT } : {});
    }
  }

  return (
    <section aria-labelledby="status-title" className="space-y-3">
      <h2 id="status-title" ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
        Status
      </h2>
      <p role="status" className="text-sm">
        {notice}
      </p>
      {/* DEBT-313: one instance per action (`key`): a status change never turns an open Disable
          confirmation into an Enable one (or back). */}
      {disabled ? (
        <ConfirmAction
          key="enable"
          trigger="Enable client"
          title="Enable this client?"
          confirmLabel="Enable client"
          path={path}
          run={() => setDisabled(false)}
          onDone={announce}
        >
          <p>The client can authenticate and get tokens again. Refresh tokens revoked when it was disabled do not come back.</p>
        </ConfirmAction>
      ) : (
        <ConfirmAction
          key="disable"
          trigger="Disable client"
          title="Disable this client?"
          confirmLabel="Disable client"
          destructive
          path={path}
          run={() => setDisabled(true)}
          onDone={announce}
        >
          <p>
            Disabling revokes every refresh token of this client. Sign-ins and token requests with it stop immediately.
            You can enable it again later.
          </p>
        </ConfirmAction>
      )}
    </section>
  );
}
