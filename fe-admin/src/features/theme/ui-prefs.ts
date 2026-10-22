import { createServerFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { THEME_COOKIE, parseTheme } from "./theme";

// Read on the server so the first HTML already has the right <html> class and sidebar state:
// no inline script (CSP, DEBT-266) and no flash. `sidebar_state` is written by the shadcn sidebar.
export const getUiPrefs = createServerFn({ method: "GET" }).handler(() => ({
  theme: parseTheme(getCookie(THEME_COOKIE)),
  sidebarOpen: getCookie("sidebar_state") !== "false",
}));
