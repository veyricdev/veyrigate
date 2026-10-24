import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { createQueryClient } from "@/features/admin-api/query-client";
import { currentCspNonce } from "@/server/security-headers";
import { routeTree } from "./routeTree.gen";

// CSP nonce (A7): on the server it comes from the server entry's per-response store
// (`withSecurityHeaders`) and the router puts it on every SSR/stream script; in the browser the
// router reads it back from `<meta property="csp-nonce">`.
const cspNonce = createIsomorphicFn()
  .server(() => currentCspNonce())
  .client(() => undefined);

// One QueryClient per router: per SSR request on the server, one in the browser (run 43 F3).
export function getRouter() {
  const queryClient = createQueryClient();
  return createRouter({
    routeTree,
    ssr: { nonce: cspNonce() },
    Wrap: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
