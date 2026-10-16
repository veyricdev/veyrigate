import {
  createBrowserRouter,
  redirect,
  type LoaderFunctionArgs,
  type RouteObject,
} from "react-router";
import Home from "./routes/Home";
import Callback, { CallbackError } from "./routes/Callback";
import Login from "./routes/Login";
import Logout from "./routes/Logout";
import Profile from "./routes/Profile";
import Tokens from "./routes/Tokens";
import ApiTest from "./routes/ApiTest";
import ErrorPage from "./routes/ErrorPage";
import {
  finishLogin,
  consumeReturnTo,
  tokens,
  isAudProbePending,
  finishAudProbe,
  restoreSessionSilently,
  consumeSilentRestoreFlag,
  startLogin,
  finishLabCallback,
  finishStateTamper,
} from "./oidc/client";
import { clearTransient } from "./oidc/transient";
import { isLabCallbackPending, takeStateTamperExpectation } from "./oidc/lab";

/**
 * The dev-only security lab page (run 25, F5). `import.meta.env.DEV` is a build-time constant, so
 * in a production build this is `null` and the `import()` — and the whole Lab chunk — is dropped.
 */
const loadLab = import.meta.env.DEV
  ? async () => ({ Component: (await import("./routes/Lab")).default })
  : null;

/**
 * Route guard loader: when there is no in-memory session, redirect anonymous users to `/login`
 * carrying the current path+query as `returnTo` (so login can round-trip them back). Fail-closed —
 * the protected element never renders without a session. The `returnTo` is the live same-origin
 * path, consumed/re-validated after login by the `/callback` loader.
 */
function requireAuth({ request }: LoaderFunctionArgs): Response | null {
  if (tokens.get() !== null) return null;
  const url = new URL(request.url);
  const returnTo = url.pathname + url.search;
  return redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
}

/**
 * React Router Data Mode (plan T1/T3). Routes: public `/` (status), `/login` (start flow),
 * `/callback` (single-flight code exchange then redirect to the validated `returnTo`), `/logout`
 * (RP-initiated), `/error` (safe OAuth error), and guarded `/profile` `/tokens` `/api-test`.
 * StrictMode's double-invoke is safe because `handleCallback` dedups by `code`.
 *
 * `lab` adds the dev-only `/lab` page and its `/callback` branches (run 25, F5). `/lab` is NOT
 * guarded: its flows leave the SPA by full navigation (dropping the in-memory session) and the
 * one-shot result must still render on return (F4).
 */
export function buildRoutes({ lab }: { lab: boolean }): RouteObject[] {
  // `DEV` first so a production build folds this to `false` and drops the lab branches entirely.
  const withLab = import.meta.env.DEV && lab;
  return [
    { path: "/", element: <Home /> },
    { path: "/login", element: <Login /> },
    { path: "/logout", element: <Logout /> },
    { path: "/error", element: <ErrorPage /> },
    {
      path: "/callback",
      element: <Callback />,
      errorElement: <CallbackError />,
      loader: async ({ request }) => {
        const params = new URL(request.url).searchParams;

        // Security-lab callbacks (dev only), checked before every other branch: a lab `/authorize`
        // scenario is recorded and NEVER exchanged; the forged-`state` check runs the real
        // `finishLogin` and must be rejected (F2/F3).
        if (withLab) {
          if (isLabCallbackPending(window.sessionStorage)) {
            finishLabCallback(params);
            return redirect("/lab");
          }
          if (takeStateTamperExpectation(params, window.sessionStorage)) {
            await finishStateTamper(params);
            return redirect("/lab");
          }
        }

        // Wrong-`aud` probe branch (Task 3): the transient is tagged `aud-probe`, so this callback
        // is the security-lab flow, NOT an ordinary login — never install a session from it.
        if (isAudProbePending()) {
          if (params.has("error")) {
            // The probe authorize failed (e.g. consent denied). Abandon the probe and rebuild the
            // main session interactively (a single login), landing back on `/api-test`.
            await startLogin("/api-test");
            return null;
          }
          // Exchange the `other` token, call `/demo/me`, record only the status, drop the token…
          await finishAudProbe(params);
          // …then rebuild the main session silently (`prompt=none`), which redirects to `/authorize`.
          await restoreSessionSilently();
          return null;
        }

        // The silent (`prompt=none`) session-restore callback that follows a probe (one-shot flag):
        // if the IdP needs interaction we fall back to EXACTLY ONE interactive login rather than the
        // safe error page, so the user transparently lands back signed in on `/api-test`.
        const silentRestore = consumeSilentRestoreFlag();

        // An authorization-error response (`?error=...`) lands on the safe error page rather than
        // attempting a code exchange that would throw a raw message (DEBT-080).
        if (params.has("error")) {
          // The login attempt is over: drop {state, nonce, code_verifier} so they cannot linger or be
          // replayed (DEBT-102). A fall-back `startLogin` below writes a fresh transient.
          clearTransient(window.sessionStorage);
          if (silentRestore) {
            await startLogin("/api-test");
            return null;
          }
          return redirect(`/error?error=${encodeURIComponent(params.get("error") ?? "")}`);
        }
        await finishLogin(params);
        // Redirect to the sanitized `returnTo` persisted before the redirect (defaults to `/`).
        return redirect(consumeReturnTo());
      },
    },
    { path: "/profile", element: <Profile />, loader: requireAuth },
    { path: "/tokens", element: <Tokens />, loader: requireAuth },
    { path: "/api-test", element: <ApiTest />, loader: requireAuth },
    ...(withLab && loadLab ? [{ path: "/lab", lazy: loadLab }] : []),
  ];
}

/** The app's route table: the lab is present only in dev (`vite dev`), never in a prod build. */
export const routes: RouteObject[] = buildRoutes({ lab: import.meta.env.DEV });

/** The app's browser router, built from the single `routes` table (shared with tests). */
export const router = createBrowserRouter(routes);