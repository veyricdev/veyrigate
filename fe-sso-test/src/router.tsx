import { createBrowserRouter, redirect } from "react-router";
import Home from "./routes/Home";
import Callback, { CallbackError } from "./routes/Callback";
import { finishLogin } from "./oidc/client";

/**
 * React Router Data Mode (plan T1/T3). The `/callback` loader performs the single-flight code
 * exchange + ID-token validation, then redirects home; its `errorElement` renders failures
 * fail-closed. StrictMode's double-invoke is safe because `handleCallback` dedups by `code`.
 */
export const router = createBrowserRouter([
  { path: "/", element: <Home /> },
  {
    path: "/callback",
    element: <Callback />,
    errorElement: <CallbackError />,
    loader: async ({ request }) => {
      const params = new URL(request.url).searchParams;
      await finishLogin(params);
      return redirect("/");
    },
  },
]);
