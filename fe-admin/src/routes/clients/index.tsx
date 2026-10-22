import { useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PagePending } from "@/components/feedback/route-states";
import { useClients } from "@/features/admin-api/hooks";
import { ClientIdSchema } from "@/features/admin-api/inputs";
import { AdminRequestError } from "@/features/admin-api/types";

/**
 * Clients list (run 44 A6.1). The admin API pages by cursor only (`clientId` ascending, no sort,
 * no filter: DEBT-300), so this page offers "next" / "first" and no total; URIs are plain text.
 */
const Search = z.object({ after: z.string().min(1).max(2048).optional().catch(undefined) });

export const Route = createFileRoute("/clients/")({
  validateSearch: Search,
  component: ClientsPage,
});

const PAGE_SIZE = 20;

function ClientsPage() {
  const { after } = Route.useSearch();
  const query = useClients({ limit: PAGE_SIZE, ...(after ? { after } : {}) });
  return (
    <section aria-labelledby="clients-title" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 id="clients-title" className="text-2xl font-semibold">
          Clients
        </h1>
        <Button asChild>
          <Link to="/clients/new">New client</Link>
        </Button>
      </div>
      <OpenById />
      {query.isPending ? (
        <PagePending />
      ) : query.isError ? (
        <div role="alert" className="space-y-3">
          <p>{query.error instanceof AdminRequestError ? query.error.message : "The clients could not be loaded."}</p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      ) : query.data.items.length === 0 ? (
        <p>{after ? "No more clients." : "No clients yet."}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Clients{after ? " (next page)" : ""}</caption>
            <thead className="border-b">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">Client ID</th>
                <th scope="col" className="py-2 pr-4 font-medium">Type</th>
                <th scope="col" className="py-2 pr-4 font-medium">Auth method</th>
                <th scope="col" className="py-2 pr-4 font-medium">Redirect URIs</th>
                <th scope="col" className="py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {query.data.items.map((c) => (
                <tr key={c.clientId} className="border-b align-top">
                  <th scope="row" className="py-2 pr-4 font-normal">
                    <Link to="/clients/$clientId" params={{ clientId: c.clientId }} className="font-mono underline-offset-4 hover:underline">
                      {c.clientId}
                    </Link>
                  </th>
                  <td className="py-2 pr-4">{c.clientType}</td>
                  <td className="py-2 pr-4">{c.tokenEndpointAuthMethod}</td>
                  <td className="py-2 pr-4 break-all">
                    {c.redirectUris[0] ?? "—"}
                    {c.redirectUris.length > 1 && (
                      <span className="text-muted-foreground"> (+{c.redirectUris.length - 1} more)</span>
                    )}
                  </td>
                  <td className="py-2">{c.disabled ? "Disabled" : "Enabled"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <nav aria-label="Pagination" className="flex gap-2">
        {after && (
          <Button asChild variant="outline">
            <Link to="/clients" search={{}}>
              First page
            </Link>
          </Button>
        )}
        {query.data?.nextCursor && (
          <Button asChild variant="outline">
            <Link to="/clients" search={{ after: query.data.nextCursor }}>
              Next page
            </Link>
          </Button>
        )}
      </nav>
    </section>
  );
}

/** Jump to a client by its id (no server search exists: DEBT-300). */
function OpenById() {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  return (
    <form
      role="search"
      className="flex max-w-md items-start gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const id = ClientIdSchema.safeParse(value.trim());
        setInvalid(!id.success);
        if (id.success) void navigate({ to: "/clients/$clientId", params: { clientId: id.data } });
      }}
    >
      <div className="flex-1 space-y-1">
        <label htmlFor="open-client-id" className="sr-only">
          Client ID
        </label>
        <Input
          id="open-client-id"
          placeholder="Client ID"
          value={value}
          aria-invalid={invalid}
          aria-describedby={invalid ? "open-client-id-error" : undefined}
          onChange={(e) => setValue(e.target.value)}
        />
        {invalid && (
          <p id="open-client-id-error" className="text-sm text-destructive">
            Enter a valid client ID.
          </p>
        )}
      </div>
      <Button type="submit" variant="outline">
        Open
      </Button>
    </form>
  );
}
