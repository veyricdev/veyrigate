import { Button } from "@/components/ui/button";
import { clearIntent } from "@/features/admin-api/step-up";

/**
 * Plain same-origin form POST to the logout server route (no JS needed; the browser sends
 * `Sec-Fetch-Site: same-origin`, which the route requires). A pending step-up draft is dropped first.
 */
export function SignOutButton({ variant = "outline" }: { variant?: "outline" | "default" }) {
  return (
    <form method="post" action="/auth/logout" onSubmit={clearIntent}>
      <Button type="submit" size="sm" variant={variant}>
        Sign out
      </Button>
    </form>
  );
}
