import { Link, createFileRoute } from "@tanstack/react-router";
import { z } from "@/lib/zod";
import { Button } from "@/components/ui/button";
import { PagePending } from "@/components/feedback/route-states";
import { useResourcePage } from "@/features/admin-api/hooks";
import { AdminRequestError } from "@/features/admin-api/types";

/**
 * Resources list (run 46 A6.2). Resources are global; the admin API pages by cursor only
 * (`identifier` ascending), so this page offers "next" / "first" and no total. `identifier` is
 * always plain text, never a link: the BE accepts any scheme (`javascript:` included).
 */
const Search = z.object({ after: z.string().min(1).max(2048).optional().catch(undefined) });

export const Route = createFileRoute("/resources/")({
  validateSearch: Search,
  component: ResourcesPage,
});

const PAGE_SIZE = 20;

function ResourcesPage() {
  const { viewer } = Route.useRouteContext();
  const { after } = Route.useSearch();
  const query = useResourcePage({ limit: PAGE_SIZE, ...(after ? { after } : {}) });
  return (
    <section aria-labelledby="resources-title" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 id="resources-title" className="text-2xl font-semibold">
          Resources
        </h1>
        {/* UX only (the BE enforces it): writes need super_admin (DEBT-325). */}
        {viewer.roles.includes("super_admin") && (
          <Button asChild>
            <Link to="/resources/new">New resource</Link>
          </Button>
        )}
      </div>
      {query.isPending ? (
        <PagePending />
      ) : query.isError ? (
        <div role="alert" className="space-y-3">
          <p>{query.error instanceof AdminRequestError ? query.error.message : "The resources could not be loaded."}</p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      ) : query.data.items.length === 0 ? (
        <p>{after ? "No more resources." : "No resources yet."}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Resources{after ? " (next page)" : ""}</caption>
            <thead className="border-b">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">Resource ID</th>
                <th scope="col" className="py-2 pr-4 font-medium">Identifier</th>
                <th scope="col" className="py-2 font-medium">Scopes</th>
              </tr>
            </thead>
            <tbody>
              {query.data.items.map((r) => (
                <tr key={r.resourceId} className="border-b align-top">
                  <th scope="row" className="py-2 pr-4 font-normal">
                    <Link
                      to="/resources/$resourceId"
                      params={{ resourceId: r.resourceId }}
                      className="font-mono underline-offset-4 hover:underline"
                    >
                      {r.resourceId}
                    </Link>
                  </th>
                  <td className="py-2 pr-4 break-all">
                    <code>{r.identifier}</code>
                  </td>
                  <td className="py-2 break-all">{r.scopes.length ? r.scopes.join(" ") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <nav aria-label="Pagination" className="flex gap-2">
        {after && (
          <Button asChild variant="outline">
            <Link to="/resources" search={{}}>
              First page
            </Link>
          </Button>
        )}
        {query.data?.nextCursor && (
          <Button asChild variant="outline">
            <Link to="/resources" search={{ after: query.data.nextCursor }}>
              Next page
            </Link>
          </Button>
        )}
      </nav>
    </section>
  );
}
