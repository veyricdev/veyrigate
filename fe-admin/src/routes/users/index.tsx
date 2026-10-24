import { useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "@/lib/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PagePending } from "@/components/feedback/route-states";
import { useUsers } from "@/features/admin-api/hooks";
import { USER_STATUSES } from "@/features/admin-api/inputs";
import { AdminRequestError } from "@/features/admin-api/types";
import { lockStatus } from "@/features/users/user-account";

/**
 * Users of the tenant (run 47 A6.3), cursor pages ("next" / "first", no total). The email filter
 * is page state only: never in the URL, the search params, `returnTo` or a GET request (the list
 * server function is a POST). Emails are plain text; a row links by user id.
 */
const Search = z.object({
  status: z.enum(USER_STATUSES).optional().catch(undefined),
  after: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/)
    .optional()
    .catch(undefined),
});

export const Route = createFileRoute("/users/")({
  validateSearch: Search,
  component: UsersPage,
});

const PAGE_SIZE = 20;

function UsersPage() {
  const { status, after } = Route.useSearch();
  const [email, setEmail] = useState<string | undefined>(undefined);
  const query = useUsers({ limit: PAGE_SIZE, ...(after ? { after } : {}), ...(status ? { status } : {}), ...(email ? { email } : {}) });
  return (
    <section aria-labelledby="users-title" className="space-y-6">
      <h1 id="users-title" className="text-2xl font-semibold">
        Users
      </h1>
      <Filters email={email} status={status} onEmail={setEmail} />
      {query.isPending ? (
        <PagePending />
      ) : query.isError ? (
        <div role="alert" className="space-y-3">
          <p>{query.error instanceof AdminRequestError ? query.error.message : "The users could not be loaded."}</p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      ) : query.data.items.length === 0 ? (
        <p>{email ? "No user with this email in this tenant." : "No users."}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Users{after ? " (next page)" : ""}</caption>
            <thead className="border-b">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">Email</th>
                <th scope="col" className="py-2 pr-4 font-medium">Lock</th>
                <th scope="col" className="py-2 pr-4 font-medium">Membership</th>
                <th scope="col" className="py-2 pr-4 font-medium">Roles</th>
                <th scope="col" className="py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {query.data.items.map((u) => (
                <tr key={u.id} className="border-b align-top">
                  <th scope="row" className="py-2 pr-4 font-normal break-all">
                    <Link to="/users/$userId" params={{ userId: u.id }} className="underline-offset-4 hover:underline">
                      {u.email}
                    </Link>
                  </th>
                  <td className="py-2 pr-4">{lockStatus(u)}</td>
                  <td className="py-2 pr-4">{u.membershipStatus}</td>
                  <td className="py-2 pr-4">{u.roles.length ? u.roles.join(", ") : "—"}</td>
                  <td className="py-2 font-mono">{u.createdAt ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <nav aria-label="Pagination" className="flex gap-2">
        {after && (
          <Button asChild variant="outline">
            <Link to="/users" search={status ? { status } : {}}>
              First page
            </Link>
          </Button>
        )}
        {query.data?.nextCursor && (
          <Button asChild variant="outline">
            <Link to="/users" search={{ ...(status ? { status } : {}), after: query.data.nextCursor }}>
              Next page
            </Link>
          </Button>
        )}
      </nav>
    </section>
  );
}

/**
 * Exact email (form state) + membership status (search param). The email input has no `name` and
 * the submit is handled here: a native submit (before hydration) never puts it in a URL.
 */
function Filters({
  email,
  status,
  onEmail,
}: {
  email: string | undefined;
  status: (typeof USER_STATUSES)[number] | undefined;
  onEmail: (email: string | undefined) => void;
}) {
  const navigate = useNavigate();
  const [value, setValue] = useState(email ?? "");
  const [nextStatus, setNextStatus] = useState<(typeof USER_STATUSES)[number] | "">(status ?? "");
  const [invalid, setInvalid] = useState(false);
  return (
    <form
      role="search"
      noValidate
      className="flex flex-wrap items-start gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = value.trim();
        const tooLong = trimmed.length > 320;
        setInvalid(tooLong);
        if (tooLong) return;
        onEmail(trimmed || undefined);
        const s = nextStatus === "" ? undefined : nextStatus;
        void navigate({ to: "/users", search: s ? { status: s } : {} }); // a new filter starts on the first page
      }}
    >
      <div className="w-full max-w-sm space-y-1">
        <label htmlFor="users-email" className="sr-only">
          Email
        </label>
        <Input
          id="users-email"
          type="email"
          autoComplete="off"
          placeholder="Exact email"
          value={value}
          aria-invalid={invalid}
          aria-describedby={invalid ? "users-email-error" : undefined}
          onChange={(e) => setValue(e.target.value)}
        />
        {invalid && (
          <p id="users-email-error" className="text-sm text-destructive">
            Enter at most 320 characters.
          </p>
        )}
      </div>
      <label htmlFor="users-status" className="sr-only">
        Membership status
      </label>
      <select
        id="users-status"
        value={nextStatus}
        onChange={(e) => setNextStatus(e.target.value as typeof nextStatus)}
        className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30"
      >
        <option value="">Any status</option>
        {USER_STATUSES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <Button type="submit" variant="outline">
        Filter
      </Button>
      {(email !== undefined || status !== undefined) && (
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setValue("");
            setNextStatus("");
            setInvalid(false);
            onEmail(undefined);
            void navigate({ to: "/users", search: {} });
          }}
        >
          Clear
        </Button>
      )}
    </form>
  );
}
