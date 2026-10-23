import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { failureMessage } from "@/components/feedback/form-feedback";
import { ResourceForm } from "@/features/resources/resource-form";
import { NewResourceDraftSchema, NewResourceSchema, type NewResourceValues } from "@/features/resources/resource-form-schema";
import { useCreateResource } from "@/features/admin-api/hooks";
import { startStepUp, useStepUpDraft } from "@/features/admin-api/step-up";
import { AdminRequestError } from "@/features/admin-api/types";

export const Route = createFileRoute("/resources/new")({ component: NewResourcePage });

const ACTION = "resource.create";
const PATH = "/resources/new";
const EMPTY: NewResourceValues = { resourceId: "", identifier: "", scopes: "" };

function NewResourcePage() {
  const { viewer } = Route.useRouteContext();
  const superAdmin = viewer.roles.includes("super_admin");
  return (
    <section aria-labelledby="new-resource-title" className="space-y-6">
      <h1 id="new-resource-title" className="text-2xl font-semibold">
        New resource
      </h1>
      {superAdmin ? (
        <NewResource sub={viewer.sub} />
      ) : (
        // UX only (the BE enforces it): no step-up just to be refused (DEBT-325).
        <p>Only a super_admin can create resources.</p>
      )}
    </section>
  );
}

function NewResource({ sub }: { sub: string }) {
  const navigate = useNavigate();
  const create = useCreateResource();
  const draft = useStepUpDraft(NewResourceDraftSchema, ACTION, PATH, sub);
  return (
    <>
      <p className="text-sm text-muted-foreground">
        A resource is global (every tenant). Its ID and identifier cannot be changed or deleted later.
      </p>
      <ResourceForm
        key={draft ? "restored" : "blank"}
        title="Details"
        initial={draft ?? EMPTY}
        schema={NewResourceSchema}
        restored={draft !== null}
        submitLabel="Create resource"
        onSubmit={async (values) => {
          try {
            const created = await create.mutateAsync(NewResourceSchema.parse(values));
            toast.success("Resource created.");
            void navigate({ to: "/resources/$resourceId", params: { resourceId: created.resourceId } });
            return null;
          } catch (err) {
            if (err instanceof AdminRequestError && err.code === "step_up_required") {
              startStepUp(NewResourceDraftSchema, { action: ACTION, path: PATH, sub, payload: values });
              return { info: "Confirm your identity to continue…" };
            }
            const message = failureMessage(
              err,
              "It may have been created — check the list before trying again (a retry that answers 'already exists' means it was).",
            );
            return message ? { error: message } : null;
          }
        }}
      />
    </>
  );
}
