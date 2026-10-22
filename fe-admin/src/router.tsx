import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

// No scrollRestoration: it injects an inline <script>; keep inline scripts to Start's own
// hydration payload until A7 sets a CSP nonce (DEBT-266/269).
export function getRouter() {
  return createRouter({ routeTree });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
