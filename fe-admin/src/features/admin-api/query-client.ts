import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { AdminRequestError } from "./types";

/** Retry only what may succeed later: `unavailable` and the generic 500/503 (thrown) errors. */
export const isTransient = (error: unknown) => !(error instanceof AdminRequestError) || error.code === "unavailable";

/** Session over => full reload through the login route (like the root guard), back to this page. */
export function signInAgain(): void {
  location.assign(`/auth/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`);
}

const onError = (error: unknown) => {
  if (error instanceof AdminRequestError && error.code === "unauthenticated") signInAgain();
};

/**
 * One client per SSR request / per browser (created in `getRouter`). No SSR prefetch, no
 * persister (DEBT-291): queries run in the browser after the guard. GETs retry transient errors at
 * most twice (the BFF itself never retries); mutations never retry and are not kept in the cache
 * (a result may hold a secret, A6.1).
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: { retry: (failures, error) => failures < 2 && isTransient(error) },
      mutations: { retry: 0, gcTime: 0 },
    },
  });
}
