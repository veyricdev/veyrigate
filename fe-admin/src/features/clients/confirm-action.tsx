import { useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { reauthenticate } from "@/features/admin-api/step-up";
import { AdminRequestError } from "@/features/admin-api/types";

/** What a confirmed action ended with: done (closes, message shown by the caller), or shown in the dialog. */
export type ActionOutcome = { done: string } | { error: string } | { stepUp: true };

/**
 * A failed admin write as an {@link ActionOutcome}. `step_up_required` keeps NO intent (run 45
 * F3.4): the admin confirms their identity on request and clicks again when back.
 */
export function outcomeOf(err: unknown, uncertainText: string, byCode: Partial<Record<string, string>> = {}): ActionOutcome {
  // A throw (network / BFF failure) is an unknown outcome too: the write may have happened (DEBT-315).
  if (!(err instanceof AdminRequestError)) return { error: uncertainText };
  if (err.code === "step_up_required") return { stepUp: true };
  if (err.uncertain) return { error: uncertainText };
  return { error: byCode[err.code] ?? err.message };
}

/** `step_up_required` without a stored intent: nothing runs by itself after the round-trip. */
export function StepUpAlert({ path }: { path: string }) {
  return (
    <div role="alert" className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
      <p>Confirm your identity to continue. Unsaved changes in Settings will be lost.</p>
      <Button type="button" variant="outline" onClick={() => reauthenticate(path)}>
        Confirm identity
      </Button>
    </div>
  );
}

interface ConfirmActionProps {
  trigger: string;
  triggerLabel?: string;
  title: string;
  /** Explanation (the dialog description). */
  children: ReactNode;
  /** Extra warning below the description (e.g. `role="alert"`). */
  warning?: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  path: string;
  run: () => Promise<ActionOutcome>;
  onDone: (message: string) => void;
}

/** A write behind a confirmation (Escape / Cancel close it; an outside click does not). */
export function ConfirmAction({ trigger, triggerLabel, title, children, warning, confirmLabel, destructive, path, run, onDone }: ConfirmActionProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ActionOutcome | null>(null);
  const busy = useRef(false); // a second click in the same tick must not send twice

  async function confirm() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setResult(null);
    try {
      const outcome = await run();
      if ("done" in outcome) {
        setOpen(false);
        onDone(outcome.done);
      } else {
        setResult(outcome);
      }
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        if (!next) setResult(null);
      }}
    >
      <AlertDialogTrigger asChild>
        <Button type="button" variant={destructive ? "destructive" : "outline"} aria-label={triggerLabel}>
          {trigger}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription asChild>
          <div className="space-y-2">{children}</div>
        </AlertDialogDescription>
        {warning}
        {result && "stepUp" in result && <StepUpAlert path={path} />}
        {result && "error" in result && (
          <p role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-destructive">
            {result.error}
          </p>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <AlertDialogCancel asChild>
            <Button type="button" variant="outline" disabled={pending}>
              Cancel
            </Button>
          </AlertDialogCancel>
          <Button type="button" variant={destructive ? "destructive" : "default"} disabled={pending} onClick={() => void confirm()}>
            {pending ? "Working…" : confirmLabel}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
