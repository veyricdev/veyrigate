import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "@/server/auth/instance";
import { withErrorPage } from "@/server/errors";

// Server route: redirect_uri of the fe-admin client (Task 2).
export const Route = createFileRoute("/auth/callback")({
  server: {
    handlers: {
      GET: withErrorPage("callback", ({ request }: { request: Request }) => getAuth().callback(request)),
    },
  },
});
