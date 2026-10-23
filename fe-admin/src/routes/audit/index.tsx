import { Fragment, useState, type ReactNode } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PagePending } from "@/components/feedback/route-states";
import { useAuditEvents } from "@/features/admin-api/hooks";
import {
  AUDIT_ACTIONS,
  AUDIT_RESULTS,
  AUDIT_TARGET_TYPES,
  AuditCursorSchema,
  AuditIdSchema,
  AuditTimeSchema,
  ClientIdSchema,
  UserIdSchema,
  type AuditListParams,
} from "@/features/admin-api/inputs";
import { AdminRequestError } from "@/features/admin-api/types";
import type { AuditEvent } from "@/server/admin-api/schemas";

/**
 * Audit log of the tenant (run 48 A6.4), newest first, cursor pages ("next" / "first", no total).
 * Every filter is a search param: enums, opaque ids (`AuditIdSchema`: never an email) and ISO
 * times. Every value is rendered as React text: no HTML, no link built from data; a user or client
 * link exists only through `<Link params>` for a valid id. IP and user agent are in the details only.
 */
const Search = z
  .object({
    action: z.enum(AUDIT_ACTIONS).optional().catch(undefined),
    result: z.enum(AUDIT_RESULTS).optional().catch(undefined),
    targetType: z.enum(AUDIT_TARGET_TYPES).optional().catch(undefined),
    actorId: AuditIdSchema.optional().catch(undefined),
    targetId: AuditIdSchema.optional().catch(undefined),
    clientId: AuditIdSchema.optional().catch(undefined),
    from: AuditTimeSchema.optional().catch(undefined),
    to: AuditTimeSchema.optional().catch(undefined),
    after: AuditCursorSchema.optional().catch(undefined),
  })
  // A reversed range from the URL is dropped (the BE would refuse it).
  .transform((s) => (s.from && s.to && Date.parse(s.from) >= Date.parse(s.to) ? { ...s, to: undefined } : s));
type AuditSearch = z.infer<typeof Search>;
type Filters = Omit<AuditSearch, "after">;

export const Route = createFileRoute("/audit/")({
  validateSearch: Search,
  component: AuditPage,
});

const PAGE_SIZE = 20;

/** The defined filters only (a clean URL and query key). */
const defined = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

function AuditPage() {
  // Named keys only: the router keeps unknown search keys (e.g. `tenantId`) next to the validated ones.
  const { action, result, targetType, actorId, targetId, clientId, from, to, after } = Route.useSearch();
  const filters = defined({ action, result, targetType, actorId, targetId, clientId, from, to }) as Filters;
  const params: AuditListParams = { limit: PAGE_SIZE, ...filters, ...(after ? { after } : {}) };
  const query = useAuditEvents(params);
  const error = query.error instanceof AdminRequestError ? query.error : null;
  return (
    <section aria-labelledby="audit-title" className="space-y-6">
      <h1 id="audit-title" className="text-2xl font-semibold">
        Audit log
      </h1>
      {/* A new search (Filter, Clear, a link) remounts the form with its values. */}
      <FilterForm key={JSON.stringify(filters)} filters={filters} />
      {/* DEBT-140: these BE events carry no tenant yet, so a tenant query never returns them. */}
      <p className="text-sm text-muted-foreground">
        Sign-in, token and session events are not yet recorded per tenant and do not appear here, except token
        reuse.
      </p>
      {query.isPending ? (
        <PagePending />
      ) : query.isError ? (
        <div role="alert" className="space-y-3">
          <p>{error ? error.message : "The audit log could not be loaded."}</p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => void query.refetch()}>
              Try again
            </Button>
            {error?.code === "invalid_request" && after && (
              <Button asChild variant="outline">
                <Link to="/audit" search={filters}>
                  First page
                </Link>
              </Button>
            )}
          </div>
        </div>
      ) : query.data.items.length === 0 ? (
        <p>No audit events.</p>
      ) : (
        <AuditTable items={query.data.items} nextPage={Boolean(after)} />
      )}
      <nav aria-label="Pagination" className="flex gap-2">
        {after && (
          <Button asChild variant="outline">
            <Link to="/audit" search={filters}>
              First page
            </Link>
          </Button>
        )}
        {query.data?.nextCursor && (
          <Button asChild variant="outline">
            <Link to="/audit" search={{ ...filters, after: query.data.nextCursor }}>
              Next page
            </Link>
          </Button>
        )}
      </nav>
    </section>
  );
}

/** Text that marks a security event (never colour only). */
function alertLabel(e: AuditEvent): string | null {
  if (e.action === "TOKEN_REUSE_DETECTED") return "Security alert: token reuse";
  if (e.action === "SIGNING_KEY_ROTATED" && e.metadata?.mode === "emergency") return "Security alert: emergency key rotation";
  return null;
}

const isUserId = (v: string | null | undefined): v is string => UserIdSchema.safeParse(v).success;
const linkClass = "underline-offset-4 hover:underline";

function AuditTable({ items, nextPage }: { items: AuditEvent[]; nextPage: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Audit events{nextPage ? " (next page)" : ""}</caption>
        <thead className="border-b">
          <tr>
            <th scope="col" className="py-2 pr-4 font-medium">Time</th>
            <th scope="col" className="py-2 pr-4 font-medium">Action</th>
            <th scope="col" className="py-2 pr-4 font-medium">Result</th>
            <th scope="col" className="py-2 pr-4 font-medium">Actor</th>
            <th scope="col" className="py-2 pr-4 font-medium">Target</th>
            <th scope="col" className="py-2 pr-4 font-medium">Client</th>
            <th scope="col" className="py-2 font-medium">
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((e, i) => {
            const id = `audit-details-${i}`;
            const expanded = open === e.eventId;
            const alert = alertLabel(e);
            return (
              <Fragment key={e.eventId}>
                <tr className="border-b align-top">
                  <th scope="row" className="py-2 pr-4 font-mono font-normal whitespace-nowrap">
                    {e.timestamp}
                  </th>
                  <td className="py-2 pr-4 break-all">
                    {e.action}
                    {alert && <strong className="mt-1 block text-destructive">{alert}</strong>}
                  </td>
                  <td className={e.result === "failure" ? "py-2 pr-4 font-semibold text-destructive" : "py-2 pr-4"}>
                    {e.result === "failure" ? "Failure" : "Success"}
                  </td>
                  <td className="py-2 pr-4 break-all">
                    <Party type={e.actorType} id={e.actorId}>
                      {(e.actorType === "user" || e.actorType === "admin") && isUserId(e.actorId) ? (
                        <Link to="/users/$userId" params={{ userId: e.actorId }} className={linkClass}>
                          {e.actorId}
                        </Link>
                      ) : null}
                    </Party>
                  </td>
                  <td className="py-2 pr-4 break-all">
                    <Party type={e.targetType} id={e.targetId}>
                      {e.targetType === "user" && isUserId(e.targetId) ? (
                        <Link to="/users/$userId" params={{ userId: e.targetId }} className={linkClass}>
                          {e.targetId}
                        </Link>
                      ) : null}
                    </Party>
                  </td>
                  <td className="py-2 pr-4 break-all">
                    {e.clientId && ClientIdSchema.safeParse(e.clientId).success ? (
                      <Link to="/clients/$clientId" params={{ clientId: e.clientId }} className={linkClass}>
                        {e.clientId}
                      </Link>
                    ) : (
                      (e.clientId ?? "—")
                    )}
                  </td>
                  <td className="py-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-expanded={expanded}
                      aria-controls={id}
                      onClick={() => setOpen(expanded ? null : e.eventId)}
                    >
                      Details
                    </Button>
                  </td>
                </tr>
                <tr id={id} hidden={!expanded} className="border-b">
                  <td colSpan={7} className="py-2">
                    {expanded && <Details event={e} />}
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** `type` + id as text, or the given link in place of the id. */
function Party({ type, id, children }: { type: string | null | undefined; id: string | null | undefined; children: ReactNode }) {
  if (!type && !id) return "—";
  return (
    <>
      {type && <span className="block text-muted-foreground">{type}</span>}
      {children ?? id}
    </>
  );
}

function Details({ event: e }: { event: AuditEvent }) {
  const rows: [string, string][] = [
    ["Event id", e.eventId],
    ["Request id", e.requestId ?? "—"],
    ["IP", e.ip ?? "—"],
    ["User agent", e.userAgent ?? "—"],
    ["Reason", e.reason ?? "—"],
    ...Object.entries(e.metadata ?? {}).map(([k, v]): [string, string] => [k, String(v)]),
  ];
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
      {rows.map(([k, v]) => (
        <Fragment key={k}>
          <dt className="font-medium">{k}</dt>
          <dd className="font-mono break-all">{v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** `datetime-local` value (local time, seconds) of an ISO instant. */
function toLocalInput(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

const ID_FIELDS = [
  ["actorId", "Actor id"],
  ["targetId", "Target id"],
  ["clientId", "Client id"],
] as const;
type IdField = (typeof ID_FIELDS)[number][0];

const selectClass = "h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30";

/**
 * Filters (form state until submit). Ids are checked with `AuditIdSchema` and the range with
 * `from < to` BEFORE navigating: an invalid value never reaches the URL or a request.
 */
function FilterForm({ filters }: { filters: Filters }) {
  const navigate = useNavigate();
  const [action, setAction] = useState(filters.action ?? "");
  const [result, setResult] = useState(filters.result ?? "");
  const [targetType, setTargetType] = useState(filters.targetType ?? "");
  const [ids, setIds] = useState<Record<IdField, string>>({
    actorId: filters.actorId ?? "",
    targetId: filters.targetId ?? "",
    clientId: filters.clientId ?? "",
  });
  const [from, setFrom] = useState(toLocalInput(filters.from));
  const [to, setTo] = useState(toLocalInput(filters.to));
  const [errors, setErrors] = useState<Partial<Record<IdField | "from" | "to", string>>>({});
  const active = Object.keys(filters).length > 0;

  const submit = () => {
    const next: Partial<Record<IdField | "from" | "to", string>> = {};
    const errs: typeof errors = {};
    for (const [key] of ID_FIELDS) {
      const v = ids[key].trim();
      if (!v) continue;
      if (AuditIdSchema.safeParse(v).success) next[key] = v;
      else errs[key] = "Use an id: letters, digits and . _ : - only (no email).";
    }
    for (const [key, v] of [
      ["from", from],
      ["to", to],
    ] as const) {
      if (!v) continue;
      const t = new Date(v);
      if (Number.isNaN(t.getTime())) errs[key] = "Enter a valid date and time.";
      else next[key] = t.toISOString();
    }
    if (next.from && next.to && next.from >= next.to) errs.to = "'To' must be after 'From'.";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    void navigate({
      to: "/audit",
      // A new filter starts on the first page (no `after`).
      search: defined({
        action: action || undefined,
        result: result || undefined,
        targetType: targetType || undefined,
        ...next,
      }) as Filters,
    });
  };

  const err = (key: IdField | "from" | "to") =>
    errors[key] && (
      <p id={`audit-${key}-error`} className="text-sm text-destructive">
        {errors[key]}
      </p>
    );
  const described = (key: IdField | "from" | "to") => (errors[key] ? `audit-${key}-error` : undefined);

  return (
    <form
      role="search"
      noValidate
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="space-y-1">
        <label htmlFor="audit-action" className="text-sm font-medium">
          Action
        </label>
        <select id="audit-action" value={action} onChange={(e) => setAction(e.target.value as typeof action)} className={`${selectClass} w-full`}>
          <option value="">Any action</option>
          {AUDIT_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <label htmlFor="audit-result" className="text-sm font-medium">
          Result
        </label>
        <select id="audit-result" value={result} onChange={(e) => setResult(e.target.value as typeof result)} className={`${selectClass} w-full`}>
          <option value="">Any result</option>
          {AUDIT_RESULTS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <label htmlFor="audit-targetType" className="text-sm font-medium">
          Target type
        </label>
        <select
          id="audit-targetType"
          value={targetType}
          onChange={(e) => setTargetType(e.target.value as typeof targetType)}
          className={`${selectClass} w-full`}
        >
          <option value="">Any target type</option>
          {AUDIT_TARGET_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      {ID_FIELDS.map(([key, label]) => (
        <div key={key} className="space-y-1">
          <label htmlFor={`audit-${key}`} className="text-sm font-medium">
            {label}
          </label>
          <Input
            id={`audit-${key}`}
            autoComplete="off"
            spellCheck={false}
            value={ids[key]}
            aria-invalid={Boolean(errors[key])}
            aria-describedby={described(key)}
            onChange={(e) => setIds({ ...ids, [key]: e.target.value })}
          />
          {err(key)}
        </div>
      ))}
      <div className="space-y-1">
        <label htmlFor="audit-from" className="text-sm font-medium">
          From (local time)
        </label>
        <Input
          id="audit-from"
          type="datetime-local"
          step={1}
          value={from}
          aria-invalid={Boolean(errors.from)}
          aria-describedby={described("from")}
          onChange={(e) => setFrom(e.target.value)}
        />
        {err("from")}
      </div>
      <div className="space-y-1">
        <label htmlFor="audit-to" className="text-sm font-medium">
          To (local time, exclusive)
        </label>
        <Input
          id="audit-to"
          type="datetime-local"
          step={1}
          value={to}
          aria-invalid={Boolean(errors.to)}
          aria-describedby={described("to")}
          onChange={(e) => setTo(e.target.value)}
        />
        {err("to")}
      </div>
      <div className="flex items-end gap-2">
        <Button type="submit" variant="outline">
          Filter
        </Button>
        {active && (
          <Button type="button" variant="ghost" onClick={() => void navigate({ to: "/audit", search: {} })}>
            Clear filters
          </Button>
        )}
      </div>
    </form>
  );
}
