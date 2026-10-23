import { Fragment } from "react";
import { Link, createFileRoute, useLocation } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { PagePending } from "@/components/feedback/route-states";
import { useUser } from "@/features/admin-api/hooks";
import { UserIdSchema } from "@/features/admin-api/inputs";
import { AdminRequestError } from "@/features/admin-api/types";
import { UserAccount, accountGate } from "@/features/users/user-account";
import { UserConsents, UserFamilies } from "@/features/users/user-grants";

export const Route = createFileRoute("/users/$userId")({ component: UserPage });

const NOT_FOUND = "This user does not exist in your tenant.";

function UserPage() {
  const { userId } = Route.useParams();
  const valid = UserIdSchema.safeParse(userId).success;
  return (
    <section aria-labelledby="user-title" className="space-y-6">
      <div className="space-y-1">
        <Link to="/users" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          ← Users
        </Link>
        <h1 id="user-title" className="text-2xl font-semibold">
          User
        </h1>
        {valid && (
          <Link
            to="/audit"
            search={{ targetType: "user", targetId: userId }}
            className="text-sm underline-offset-4 hover:underline"
          >
            Audit events for this account
          </Link>
        )}
      </div>
      {/* An id that is not 24 hex is never sent to the BE. */}
      {valid ? (
        // State of dialogs and notices belongs to one user: a new `userId` remounts everything.
        <Fragment key={userId}>
          <UserDetail userId={userId} />
        </Fragment>
      ) : (
        <p role="alert">{NOT_FOUND}</p>
      )}
    </section>
  );
}

function UserDetail({ userId }: { userId: string }) {
  const { viewer } = Route.useRouteContext();
  const path = useLocation({ select: (l) => l.pathname });
  const query = useUser(userId);
  // DEBT-320: once the user is `not_found` (also on a re-read after a write), no write is offered.
  const gone = query.error instanceof AdminRequestError && query.error.code === "not_found";
  return (
    <>
      {query.isPending && <PagePending />}
      {query.isError && (
        <div role="alert" className="space-y-3">
          <p>{gone ? NOT_FOUND : query.error instanceof AdminRequestError ? query.error.message : "The user could not be loaded."}</p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      )}
      {query.data !== undefined && (
        <>
          <UserAccount user={query.data} viewer={viewer} path={path} writable={!gone} />
          <UserFamilies userId={userId} path={path} self={accountGate(viewer, query.data).self} writable={!gone} />
          <UserConsents userId={userId} path={path} writable={!gone} />
        </>
      )}
    </>
  );
}
