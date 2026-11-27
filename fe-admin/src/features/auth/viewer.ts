import { createServerFn } from "@tanstack/react-start";
import { appendResponseHeader, getRequest } from "@tanstack/react-start/server";
import { getAuth } from "@/server/auth/instance";
import type { Viewer } from "./viewer-types";

/**
 * Current viewer for the route guard and the header. Runs on the server only (SSR call or
 * `/_serverFn` RPC): reads the session, refreshes tokens if needed and returns the allowlisted
 * {@link Viewer}, never a token.
 */
export const getViewer = createServerFn({ method: "GET" }).handler(async (): Promise<Viewer | null> => {
  const { viewer, setCookie } = await getAuth().viewer(getRequest());
  if (setCookie) appendResponseHeader("set-cookie", setCookie); // append: never drop another cookie
  return viewer;
});
