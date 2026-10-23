import { Fragment, useRef } from "react";
import { Link, createFileRoute, useLocation } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { PagePending } from "@/components/feedback/route-states";
import { failureMessage } from "@/components/feedback/form-feedback";
import { ClientForm } from "@/features/clients/client-form";
import { SecretsPanel } from "@/features/clients/client-secrets";
import { ClientStatus } from "@/features/clients/client-status";
import { EditDraftSchema, changedValues, toPatch, valuesFrom } from "@/features/clients/client-form-schema";
import { useClient, useResources, useUpdateClient } from "@/features/admin-api/hooks";
import { startStepUp, useStepUpDraft } from "@/features/admin-api/step-up";
import { AdminRequestError } from "@/features/admin-api/types";
import type { AdminClient } from "@/server/admin-api/schemas";

export const Route = createFileRoute("/clients/$clientId")({ component: ClientPage });

const ACTION = "client.update";

function ClientPage() {
  const { clientId } = Route.useParams();
  const query = useClient(clientId);
  const path = useLocation({ select: (l) => l.pathname });
  return (
    <section aria-labelledby="client-title" className="space-y-6">
      <div className="space-y-1">
        <Link to="/clients" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          ← Clients
        </Link>
        <h1 id="client-title" className="font-mono text-2xl font-semibold break-all">
          {clientId}
        </h1>
      </div>
      {query.isPending && <PagePending />}
      {query.isError && (
        <div role="alert" className="space-y-3">
          <p>
            {query.error instanceof AdminRequestError && query.error.code === "not_found"
              ? "This client does not exist in your tenant."
              : query.error instanceof AdminRequestError
                ? query.error.message
                : "The client could not be loaded."}
          </p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      )}
      {/* DEBT-316: a failed re-read keeps the last data below the error (a shown one-time secret stays). */}
      {query.data !== undefined && (
        // DEBT-308: everything below is per client (form, secret dialog, confirmations): a new
        // `clientId` remounts it even when its detail is already cached.
        <Fragment key={clientId}>
          <ClientFacts client={query.data} />
          <EditClient client={query.data} />
          {query.data.clientType === "confidential" && <SecretsPanel clientId={clientId} path={path} />}
          <ClientStatus clientId={clientId} disabled={query.data.disabled} path={path} />
        </Fragment>
      )}
    </section>
  );
}

/** Immutable facts: shown as text, never part of the form (and never in a PATCH). */
function ClientFacts({ client }: { client: AdminClient }) {
  const rows: [string, string][] = [
    ["Type", client.clientType],
    ["Token endpoint auth method", client.tokenEndpointAuthMethod],
    ["Status", client.disabled ? "Disabled" : "Enabled"],
    ["Created", client.createdAt ?? "—"],
    ["Updated", client.updatedAt ?? "—"],
  ];
  return (
    <dl className="grid max-w-2xl grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
      {rows.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="font-mono break-all">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function EditClient({ client }: { client: AdminClient }) {
  const { viewer } = Route.useRouteContext();
  const path = useLocation({ select: (l) => l.pathname });
  const draft = useStepUpDraft(EditDraftSchema, ACTION, path, viewer.sub);
  const update = useUpdateClient();
  const resources = useResources();
  // DEBT-330: fields of an `uncertain` PATCH have an unknown server value (the frozen base may be
  // stale): they are sent again on the next save, until a save confirms the values.
  const unknown = useRef(new Set<string>());
  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Settings</h2>
      <ClientForm
        key={draft ? "restored" : "blank"}
        initial={{ ...valuesFrom(client), ...draft }}
        // Mount (also on a draft restore: key change) = the server data then, without the draft.
        base={valuesFrom(client)}
        restored={draft !== null}
        resources={{ options: resources.data, failed: resources.isError }}
        submitLabel="Save changes"
        onSubmit={async (fields, values, base) => {
          // Only what this admin changed vs the values the form shows as loaded (it never follows a refetch).
          const changed = changedValues(values, base, unknown.current);
          const patch = toPatch(fields, changed);
          if (Object.keys(patch).length === 0) return { info: "No changes to save." };
          try {
            const saved = await update.mutateAsync({ clientId: client.clientId, patch });
            unknown.current.clear();
            return { saved: valuesFrom(saved) };
          } catch (err) {
            if (err instanceof AdminRequestError && err.code === "step_up_required") {
              startStepUp(EditDraftSchema, { action: ACTION, path, sub: viewer.sub, payload: changed });
              return { info: "Confirm your identity to continue…" };
            }
            if (!(err instanceof AdminRequestError) || err.uncertain) {
              for (const key of Object.keys(patch)) unknown.current.add(key);
            }
            const message = failureMessage(
              err,
              "The result is unknown. Saving again sends the fields you just tried to change.",
            );
            return message ? { error: message } : null;
          }
        }}
      />
    </div>
  );
}
