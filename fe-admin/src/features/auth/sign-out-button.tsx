import { Button } from "@/components/ui/button";

/**
 * Plain same-origin form POST to the logout server route (no JS needed; the browser sends
 * `Sec-Fetch-Site: same-origin`, which the route requires).
 */
export function SignOutButton({ variant = "outline" }: { variant?: "outline" | "default" }) {
  return (
    <form method="post" action="/auth/logout">
      <Button type="submit" size="sm" variant={variant}>
        Sign out
      </Button>
    </form>
  );
}
