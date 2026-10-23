import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Router `Wrap` for layout/guard tests that render `/` (run 50: the dashboard reads the admin API):
 * a query client whose queries never run, so these tests stay about the shell and send no request.
 */
export function IdleQueries({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { enabled: false } } }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
