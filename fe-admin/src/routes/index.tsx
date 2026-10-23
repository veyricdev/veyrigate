import type { ReactNode } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  useBackendHealth,
  useClients,
  useResourcePage,
  useSigningKeys,
  useUsers,
} from "@/features/admin-api/hooks";
import { listAudit } from "@/features/admin-api/audit";
import { adminKeys } from "@/features/admin-api/keys";
import { AdminRequestError, unwrap, type BackendHealth } from "@/features/admin-api/types";
import { alertLabel } from "@/features/audit/alert-label";
import { COUNT_LIMIT, RECENT_LIMIT, SECURITY_ACTIONS, countText, mergeRecent } from "@/features/dashboard/summary";

/**
 * Dashboard (run 50 A6.6): counts, recent security events and IdP readiness from the admin API.
 * Every block has its own query and its own error + "Try again": one failure never hides the others.
 * Read once on mount (no polling). Counts read one page of 100 (no BE count, DEBT-356). The signing
 * keys card is mounted for a super_admin only (the BE refuses anyone else: no request is sent).
 */
export const Route = createFileRoute("/")({ component: DashboardPage });

const linkClass = "text-sm underline underline-offset-4";

function DashboardPage() {
  const { viewer } = Route.useRouteContext();
  const superAdmin = viewer.roles.includes("super_admin");
  return (
    <section aria-labelledby="dashboard-title" className="space-y-6">
      <h1 id="dashboard-title" className="text-2xl font-semibold">
        Dashboard
      </h1>
      <HealthBlock />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <ClientsCard />
        <UsersCard />
        <ResourcesCard />
        {superAdmin && <SigningKeysCard />}
      </div>
      <SecurityEvents />
    </section>
  );
}

/** The error text of a failed block: the typed BFF message, or a fixed one (never a raw error). */
const errorText = (error: unknown, fallback: string) => (error instanceof AdminRequestError ? error.message : fallback);

function BlockError({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div role="alert" className="space-y-2 text-sm">
      <p>{text}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function Card({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-2 rounded-lg border p-4">
      <h2 id={id} className="text-sm font-medium text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

function CountCard({
  id,
  title,
  query,
  to,
  linkText,
}: {
  id: string;
  title: string;
  query: UseQueryResult<{ items: unknown[]; nextCursor: string | null }>;
  to: "/clients" | "/users" | "/resources";
  linkText: string;
}) {
  let body: ReactNode;
  if (query.isPending) body = <p role="status">Loading…</p>;
  else if (query.isError)
    body = <BlockError text={errorText(query.error, "The count could not be loaded.")} onRetry={() => void query.refetch()} />;
  else {
    const text = countText(query.data);
    body = (
      <p className="text-3xl font-semibold">
        {text === String(query.data.items.length) ? (
          text
        ) : (
          <>
            <span aria-hidden="true">{text}</span>
            <span className="sr-only">More than {COUNT_LIMIT}</span>
          </>
        )}
      </p>
    );
  }
  return (
    <Card id={id} title={title}>
      {body}
      <Link to={to} className={linkClass}>
        {linkText}
      </Link>
    </Card>
  );
}

const ClientsCard = () => (
  <CountCard
    id="count-clients"
    title="Clients (this tenant)"
    query={useClients({ limit: COUNT_LIMIT })}
    to="/clients"
    linkText="Open clients"
  />
);
const UsersCard = () => (
  <CountCard id="count-users" title="Users (this tenant)" query={useUsers({ limit: COUNT_LIMIT })} to="/users" linkText="Open users" />
);
const ResourcesCard = () => (
  <CountCard
    id="count-resources"
    title="Resources (all tenants)"
    query={useResourcePage({ limit: COUNT_LIMIT })}
    to="/resources"
    linkText="Open resources"
  />
);

function SigningKeysCard() {
  const query = useSigningKeys();
  let body: ReactNode;
  if (query.isPending) body = <p role="status">Loading…</p>;
  else if (query.isError)
    body = <BlockError text={errorText(query.error, "The signing keys could not be loaded.")} onRetry={() => void query.refetch()} />;
  else {
    const active = query.data.items.find((k) => k.status === "active");
    const retiring = query.data.items.filter((k) => k.status === "retiring").length;
    body = (
      <dl className="space-y-1 text-sm">
        <dt className="text-muted-foreground">Active key</dt>
        <dd className="font-mono break-all">{active?.kid ?? "None"}</dd>
        <dt className="text-muted-foreground">Retiring keys</dt>
        <dd>{retiring}</dd>
      </dl>
    );
  }
  return (
    <Card id="count-keys" title="Signing keys">
      {body}
      <Link to="/keys" className={linkClass}>
        Open signing keys
      </Link>
    </Card>
  );
}

const HEALTH_TEXT: Record<BackendHealth, string> = {
  up: "Up",
  down: "Down — a dependency is not ready",
  unknown: "Unknown — no answer from the identity provider",
};

function HealthBlock() {
  const query = useBackendHealth();
  // A failed server function is "Unknown" too: never "Up" when unsure.
  const text = query.isPending ? "Checking…" : HEALTH_TEXT[query.isError ? "unknown" : query.data];
  return (
    <section aria-labelledby="health-title" className="flex flex-wrap items-center gap-3 rounded-lg border p-4">
      <h2 id="health-title" className="text-sm font-medium">
        Identity provider status
      </h2>
      <p role="status" className="text-sm">
        Identity provider: {text}
      </p>
      {!query.isPending && (
        <Button variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>
          Check again
        </Button>
      )}
    </section>
  );
}

function SecurityEvents() {
  const queries = useQueries({
    queries: SECURITY_ACTIONS.map((action) => {
      const params = { action, limit: RECENT_LIMIT };
      return {
        queryKey: adminKeys.audit.list(params),
        queryFn: async () => unwrap(await listAudit({ data: params })),
      };
    }),
  });
  const failed = queries.filter((q) => q.isError);
  let body: ReactNode;
  if (failed.length > 0) {
    // Fail-closed: a partial list (or "no events") would claim something the IdP did not say.
    body = (
      <BlockError
        text={errorText(failed[0].error, "Recent security events could not be loaded.")}
        onRetry={() => failed.forEach((q) => void q.refetch())}
      />
    );
  } else if (queries.some((q) => q.isPending)) {
    body = <p role="status">Loading…</p>;
  } else {
    const events = mergeRecent(queries.map((q) => q.data?.items ?? []));
    body =
      events.length === 0 ? (
        <p>No recent security events in this tenant.</p>
      ) : (
        <ul className="divide-y text-sm">
          {events.map((e) => {
            const alert = alertLabel(e);
            return (
              <li key={e.eventId} className="space-y-1 py-2">
                <p className="break-all">
                  <span className="font-medium">{e.action}</span>
                  {alert && <strong className="ml-2 text-destructive">{alert}</strong>}
                </p>
                <p className="text-muted-foreground">
                  <span className="font-mono">{e.timestamp}</span> · {e.result === "failure" ? "Failure" : "Success"} ·
                  Target: <span className="break-all">{e.targetId ?? "—"}</span>
                </p>
                <Link to="/audit" search={{ action: e.action as (typeof SECURITY_ACTIONS)[number] }} className={linkClass}>
                  View in audit log<span className="sr-only"> ({e.action} events)</span>
                </Link>
              </li>
            );
          })}
        </ul>
      );
  }
  return (
    <section aria-labelledby="events-title" className="space-y-2">
      <h2 id="events-title" className="text-lg font-semibold">
        Recent security events
      </h2>
      <p className="text-sm text-muted-foreground">Events recorded for this tenant.</p>
      {body}
    </section>
  );
}
