import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "@/server/auth/instance";
import { withErrorPage } from "@/server/errors";

// Server route: POST only (same-origin form); any other method => 405 (Task 4).
const handler = withErrorPage("logout", ({ request }: { request: Request }) => getAuth().logout(request));

export const Route = createFileRoute("/auth/logout")({
  server: { handlers: { POST: handler, ANY: handler } },
});
