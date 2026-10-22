import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "@/server/auth/instance";
import { withErrorPage } from "@/server/errors";

// Server route: starts the OIDC authorization code + PKCE flow (Task 2).
export const Route = createFileRoute("/auth/login")({
  server: {
    handlers: {
      GET: withErrorPage("login", ({ request }: { request: Request }) => getAuth().login(request)),
    },
  },
});
