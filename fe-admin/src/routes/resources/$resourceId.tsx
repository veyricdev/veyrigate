import { Fragment, useState } from "react";
import { Link, createFileRoute, useLocation } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { PagePending } from "@/components/feedback/route-states";
import { failureMessage } from "@/features/clients/client-form";
import { ResourceForm } from "@/features/resources/resource-form";
import {
  EditResourceDraftSchema,
  EditResourceSchema,
  sameScopes,
  type EditResourceValues,
} from "@/features/resources/resource-form-schema";
import { useResource, useUpdateResource } from "@/features/admin-api/hooks";
import { startStepUp, useStepUpDraft } from "@/features/admin-api/step-up";
import { AdminRequestError } from "@/features/admin-api/types";
import type { AdminResource } from "@/server/admin-api/schemas";

export const Route = createFileRoute("/resources/$resourceId")({ component: ResourcePage });

const ACTION = "resource.update";

const valuesFrom = (r: AdminResource): EditResourceValues => ({ scopes: r.scopes.join(" ") });

function ResourcePage() {
  const { resourceId } = Route.useParams();
  const query = useResource(resourceId);
  return (
    <section aria-labelledby="resource-title" className="space-y-6">
      <div className="space-y-1">
        <Link to="/resources" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          ← Resources
        </Link>
        <h1 id="resource-title" className="font-mono text-2xl font-semibold break-all">
          {resourceId}
        </h1>
      </div>
      {query.isPending && <PagePending />}
      {query.isError && (
        <div role="alert" className="space-y-3">
          <p>
            {query.error instanceof AdminRequestError && query.error.code === "not_found"
              ? "This resource does not exist."
              : query.error instanceof AdminRequestError
                ? query.error.message
                : "The resource could not be loaded."}
          </p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      )}
      {query.data !== undefined && (
        // DEBT-308: a new `resourceId` remounts the facts and the form (no draft carried over).
        <Fragment key={resourceId}>
          <dl className="grid max-w-2xl grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Identifier</dt>
            {/* Plain text, never a link: the BE accepts any scheme. */}
            <dd className="font-mono break-all">{query.data.identifier}</dd>
          </dl>
          <EditScopes resource={query.data} />
        </Fragment>
      )}
    </section>
  );
}

function EditScopes({ resource }: { resource: AdminResource }) {
  const { viewer } = Route.useRouteContext();
  if (!viewer.roles.includes("super_admin")) {
    // UX only (the BE enforces it): no step-up just to be refused (DEBT-325).
    return (
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Scopes</h2>
        <p className="font-mono text-sm break-all">{resource.scopes.length ? resource.scopes.join(" ") : "—"}</p>
        <p className="text-xs text-muted-foreground">Only a super_admin can change them.</p>
      </div>
    );
  }
  return <EditScopesForm resource={resource} sub={viewer.sub} />;
}

function EditScopesForm({ resource, sub }: { resource: AdminResource; sub: string }) {
  const path = useLocation({ select: (l) => l.pathname });
  const draft = useStepUpDraft(EditResourceDraftSchema, ACTION, path, sub);
  const update = useUpdateResource();
  // Case 9 / DEBT-327: after an unknown outcome the server value is unknown, so the frozen diff base
  // is not trusted: the next save is always sent (PATCH replaces the whole list: idempotent) and the
  // re-read value is shown beside the form (never written into the admin's draft).
  const [unsure, setUnsure] = useState(false);
  return (
    <>
      <ResourceForm
        key={draft ? "restored" : "blank"}
        title="Scopes"
        initial={draft ?? valuesFrom(resource)}
        // Mount (also on a draft restore) = the server data then; never follows a refetch.
        base={valuesFrom(resource)}
        schema={EditResourceSchema}
        restored={draft !== null}
        submitLabel="Save scopes"
        onSubmit={async (values, base) => {
          if (!unsure && sameScopes(values.scopes, base.scopes)) return { info: "No changes to save." };
          try {
            const { scopes } = EditResourceSchema.parse(values);
            const saved = await update.mutateAsync({ resourceId: resource.resourceId, patch: { scopes } });
            setUnsure(false);
            return { saved: valuesFrom(saved), info: "Saved." };
          } catch (err) {
            if (err instanceof AdminRequestError && err.code === "step_up_required") {
              startStepUp(EditResourceDraftSchema, { action: ACTION, path, sub, payload: { scopes: values.scopes } });
              return { info: "Confirm your identity to continue…" };
            }
            if (!(err instanceof AdminRequestError) || err.uncertain) setUnsure(true);
            const message = failureMessage(
              err,
              "The result is unknown. The saved scopes are shown below the form; saving again sends your values.",
            );
            return message ? { error: message } : null;
          }
        }}
      />
      {unsure && (
        <p className="font-mono text-sm break-all">
          <span className="font-sans text-muted-foreground">Currently saved: </span>
          {resource.scopes.length ? resource.scopes.join(" ") : "—"}
        </p>
      )}
    </>
  );
}
