import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useRevokeSecret, useSecrets } from "@/features/admin-api/hooks";
import { adminKeys } from "@/features/admin-api/keys";
import { signInAgain } from "@/features/admin-api/query-client";
import { issueSecret } from "@/features/admin-api/secrets";
import { AdminRequestError, unwrap } from "@/features/admin-api/types";
import type { Credential } from "@/server/admin-api/schemas";
import { ConfirmAction, StepUpAlert, outcomeOf, useActionNotice, type ActionOutcome } from "./confirm-action";

const usable = (c: Credential) => c.status === "active" || c.status === "grace";

export const UNCERTAIN_ISSUE =
  "A new version may have been created without its secret being shown. Check the version list, revoke any version you do not recognise, then rotate again.";

/**
 * Secrets of a confidential client (run 45 A6.1b): version metadata, issue/rotate (the plaintext is
 * shown once, in {@link IssueSecretDialog}) and revoke. Render only for a confidential client.
 */
export function SecretsPanel({ clientId, path }: { clientId: string; path: string }) {
  const secrets = useSecrets(clientId);
  const revoke = useRevokeSecret();
  const { notice, headingRef, announce } = useActionNotice();
  const items = secrets.data?.items ?? [];
  const usableCount = items.filter(usable).length;

  async function revokeVersion(version: number): Promise<ActionOutcome> {
    try {
      await revoke.mutateAsync({ clientId, version });
      return { done: `Version ${version} revoked.` };
    } catch (err) {
      if (err instanceof AdminRequestError && err.code === "not_found") void secrets.refetch();
      return outcomeOf(err, "The result is unknown. The version list was reloaded: check it before trying again.", {
        not_found: "This version was already revoked or does not exist. The version list was reloaded.",
      });
    }
  }

  return (
    <section aria-labelledby="secrets-title" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="secrets-title" ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
          Secrets
        </h2>
        {/* DEBT-314: data, not isSuccess: a failed re-read must not unmount a shown one-time secret. */}
        {secrets.data !== undefined && (
          <IssueSecretDialog clientId={clientId} path={path} rotate={usableCount > 0} />
        )}
      </div>
      <p role="status" className="text-sm">
        {notice}
      </p>
      {secrets.isPending ? (
        <p className="text-sm text-muted-foreground">Loading secrets…</p>
      ) : secrets.isError ? (
        <div role="alert" className="space-y-2 text-sm">
          <p>{secrets.error instanceof AdminRequestError ? secrets.error.message : "The secrets could not be loaded."}</p>
          <Button variant="outline" onClick={() => void secrets.refetch()}>
            Try again
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No secret yet. Issue one to let this client authenticate.</p>
      ) : (
        <div className="overflow-x-auto">
          <table aria-label="Secret versions" className="w-full max-w-3xl text-left text-sm">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 pr-4 font-medium">Version</th>
                <th className="py-1 pr-4 font-medium">Status</th>
                <th className="py-1 pr-4 font-medium">Created</th>
                <th className="py-1 pr-4 font-medium">Expires</th>
                <th className="py-1 pr-4 font-medium">Revoked</th>
                <th className="py-1 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {items.map((c) => (
                <tr key={c.version} className="border-t">
                  <td className="py-1 pr-4">{c.version}</td>
                  <td className="py-1 pr-4">{c.status}</td>
                  <td className="py-1 pr-4">{c.createdAt}</td>
                  <td className="py-1 pr-4">{c.expiresAt ?? "—"}</td>
                  <td className="py-1 pr-4">{c.revokedAt ?? "—"}</td>
                  <td className="py-1 font-sans">
                    {usable(c) && (
                      <ConfirmAction
                        trigger="Revoke"
                        triggerLabel={`Revoke version ${c.version}`}
                        title={`Revoke version ${c.version}?`}
                        confirmLabel="Revoke"
                        destructive
                        path={path}
                        warning={
                          usableCount === 1 && (
                            <p role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-destructive">
                              This is the last usable secret of this client: every client authentication (/token, /revoke,
                              /introspect) will fail until you issue a new secret.
                            </p>
                          )
                        }
                        run={() => revokeVersion(c.version)}
                        onDone={announce}
                      >
                        <p>
                          Version {c.version} stops working immediately, with no grace period. Tokens already issued with
                          it are not revoked.
                        </p>
                      </ConfirmAction>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Issue / rotate (same endpoint). The dialog only closes with its buttons or Escape. */
function IssueSecretDialog({ clientId, path, rotate }: { clientId: string; path: string; rotate: boolean }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const label = rotate ? "Rotate secret" : "Issue secret";
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) setOpen(next); // a pending issue keeps the dialog: its secret is shown once
      }}
    >
      <DialogTrigger asChild>
        <Button type="button">{label}</Button>
      </DialogTrigger>
      <DialogContent onInteractOutside={(e) => e.preventDefault()}>
        <IssueSecretBody
          clientId={clientId}
          path={path}
          label={label}
          rotate={rotate}
          pending={pending}
          setPending={setPending}
          close={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

interface IssueSecretBodyProps {
  clientId: string;
  path: string;
  label: string;
  rotate: boolean;
  pending: boolean;
  setPending: (pending: boolean) => void;
  close: () => void;
}

/**
 * Mounted only while the dialog is open: the plaintext lives in THIS component's state only (no
 * `useMutation`, no Query cache, no storage, no URL, no toast, no log) and is gone on close.
 */
function IssueSecretBody({ clientId, path, label, rotate, pending, setPending, close }: IssueSecretBodyProps) {
  const queryClient = useQueryClient();
  const secrets = useSecrets(clientId); // metadata only: grace end of the previous version
  const [issued, setIssued] = useState<{ version: number; secret: string } | null>(null);
  const [failure, setFailure] = useState<ActionOutcome | null>(null);
  const [copy, setCopy] = useState<"copied" | "failed" | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    // Leaving the page (also into the back/forward cache) drops the secret.
    const drop = () => {
      setIssued(null);
      close();
    };
    window.addEventListener("pagehide", drop);
    return () => window.removeEventListener("pagehide", drop);
  }, [close]);

  async function issue() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setFailure(null);
    try {
      const result = unwrap(await issueSecret({ data: clientId }));
      setIssued({ version: result.version, secret: result.clientSecret });
    } catch (err) {
      if (err instanceof AdminRequestError && err.code === "unauthenticated") signInAgain();
      else setFailure(outcomeOf(err, UNCERTAIN_ISSUE));
    } finally {
      busy.current = false;
      setPending(false);
      void queryClient.invalidateQueries({ queryKey: adminKeys.clients.secrets(clientId) });
    }
  }

  async function copySecret(secret: string) {
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(secret);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }

  if (issued) {
    const list = secrets.data?.items;
    const refreshed = list?.some((c) => c.version === issued.version);
    const graceful = refreshed ? list!.filter((c) => c.status === "grace" && c.version < issued.version) : [];
    return (
      <>
        <DialogTitle>Secret version {issued.version}</DialogTitle>
        <DialogDescription>Client {clientId}</DialogDescription>
        <p role="status" className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
          Copy this secret now. It is shown only once and cannot be shown again after you close this dialog.
        </p>
        <code data-testid="issued-secret" className="block rounded-md border bg-muted p-3 font-mono break-all select-all">
          {issued.secret}
        </code>
        {graceful.map((c) => (
          <p key={c.version}>
            Version {c.version} keeps working until {c.expiresAt}.
          </p>
        ))}
        <p role="status" className="text-sm">
          {copy === "copied"
            ? "Copied. Clear your clipboard once the secret is stored."
            : copy === "failed"
              ? "Copy failed — select the text and copy it manually."
              : ""}
        </p>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => void copySecret(issued.secret)}>
            Copy
          </Button>
          <Button type="button" onClick={close}>
            Close
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogTitle>{label}</DialogTitle>
      <DialogDescription>
        {rotate
          ? "A new secret version is created. The current version keeps working for the grace period, then expires."
          : "A new secret is created for this client."}{" "}
        The secret is shown only once.
      </DialogDescription>
      {failure && "stepUp" in failure && <StepUpAlert path={path} />}
      {failure && "error" in failure && (
        <p role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-destructive">
          {failure.error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={pending} onClick={close}>
          Cancel
        </Button>
        <Button type="button" disabled={pending} onClick={() => void issue()}>
          {pending ? "Working…" : label}
        </Button>
      </DialogFooter>
    </>
  );
}
