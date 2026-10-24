import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { AdminRequestError } from "./types";

/** Retry only what may succeed later: `unavailable` and the generic 500/503 (thrown) errors. */
export const isTransient = (error: unknown) => !(error instanceof AdminRequestError) || error.code === "unavailable";

/** How long after Sign out automatic navigation stays muted (DEBT-374: never stuck for good). */
const SIGN_OUT_WINDOW_MS = 10_000;
let signingOutUntil = 0;

/**
 * Sign-out started (run 51): for the next 10 s no automatic navigation (sign in again, step-up) may
 * run, since it would abort the logout POST before it reaches the IdP end_session and the still-live
 * IdP session would sign the admin straight back in. Queries in flight are cancelled; an
 * `unauthenticated` that still arrives (a mutation, a direct call) is ignored. The window expires on
 * its own (DEBT-374): if the POST never unloads the page, automatic sign-in works again afterwards.
 */
export function beginSignOut(queryClient: QueryClient): void {
  signingOutUntil = Date.now() + SIGN_OUT_WINDOW_MS;
  void queryClient.cancelQueries();
}

export const isSigningOut = () => Date.now() < signingOutUntil;

/** Session over => full reload through the login route (like the root guard), back to this page. */
export function signInAgain(): void {
  if (isSigningOut()) return;
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
