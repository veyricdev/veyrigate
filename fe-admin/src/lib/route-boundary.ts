import { createIsomorphicFn } from "@tanstack/react-start";
import { toPublicError } from "@/server/errors";

// On the server an error is logged and replaced before the router dehydrates it into the SSR
// HTML (DEBT-275); in the browser it is already client-side, nothing to hide.
const sanitize = createIsomorphicFn()
  .server((where: string, err: unknown) => toPublicError(where, err).error)
  .client((_where: string, err: unknown) => err);

/** Runs a loader / beforeLoad body behind the server error boundary. */
export async function safely<T>(where: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw sanitize(where, err);
  }
}
