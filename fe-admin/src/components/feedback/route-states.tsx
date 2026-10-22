import { Link, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route error boundary. Error details only when `showDetails` (dev build); in production the
 * message/stack may carry internals (or secrets from a failed upstream call), so only a generic
 * text and a retry are rendered.
 */
export function RouteError({
  error,
  reset,
  showDetails = import.meta.env.DEV,
}: ErrorComponentProps & { showDetails?: boolean }) {
  const router = useRouter();
  return (
    <div role="alert" className="mx-auto max-w-lg space-y-4 py-12 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-muted-foreground">An unexpected error occurred. Please try again.</p>
      {showDetails && (
        <pre className="overflow-auto rounded-md bg-muted p-3 text-left text-xs">{String(error)}</pre>
      )}
      <Button
        onClick={() => {
          reset();
          void router.invalidate();
        }}
      >
        Try again
      </Button>
    </div>
  );
}

export function NotFound() {
  return (
    <div className="mx-auto max-w-lg space-y-4 py-12 text-center">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-muted-foreground">The page you are looking for does not exist.</p>
      <Button asChild variant="outline">
        <Link to="/">Back to dashboard</Link>
      </Button>
    </div>
  );
}

export function PagePending() {
  return (
    <div role="status" aria-label="Loading" className="space-y-3">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-full max-w-md" />
      <Skeleton className="h-4 w-full max-w-sm" />
    </div>
  );
}
