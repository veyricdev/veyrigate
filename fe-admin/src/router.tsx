import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { createQueryClient } from "@/features/admin-api/query-client";
import { routeTree } from "./routeTree.gen";

// No scrollRestoration: it injects an inline <script>; keep inline scripts to Start's own
// hydration payload until A7 sets a CSP nonce (DEBT-266/269).
// One QueryClient per router: per SSR request on the server, one in the browser (run 43 F3).
export function getRouter() {
  const queryClient = createQueryClient();
  return createRouter({
    routeTree,
    Wrap: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
