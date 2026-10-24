import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { beginSignOut } from "@/features/admin-api/query-client";
import { clearIntent } from "@/features/admin-api/step-up";

/**
 * Plain same-origin form POST to the logout server route (no JS needed; the browser sends
 * `Sec-Fetch-Site: same-origin`, which the route requires). Before it leaves, automatic sign-in
 * redirects are switched off (they would abort this POST) and a pending step-up draft is dropped.
 */
export function SignOutButton({ variant = "outline" }: { variant?: "outline" | "default" }) {
  const queryClient = useQueryClient();
  const onSubmit = () => {
    beginSignOut(queryClient);
    clearIntent();
  };
  return (
    <form method="post" action="/auth/logout" onSubmit={onSubmit}>
      <Button type="submit" size="sm" variant={variant}>
        Sign out
      </Button>
    </form>
  );
}
