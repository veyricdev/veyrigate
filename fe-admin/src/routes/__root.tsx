import type { ReactNode } from "react";
import { HeadContent, Outlet, Scripts, createRootRoute, redirect } from "@tanstack/react-router";
import { AppLayout } from "@/components/layout/app-layout";
import { Forbidden, NotFound, PagePending, RouteError } from "@/components/feedback/route-states";
import { Toaster } from "@/components/ui/sonner";
import { themeClass } from "@/features/theme/theme";
import { ThemeProvider, useTheme } from "@/features/theme/theme-provider";
import { getUiPrefs } from "@/features/theme/ui-prefs";
import { getViewer } from "@/features/auth/viewer";
import { isAdmin } from "@/features/auth/viewer-types";
import { safely } from "@/lib/route-boundary";
import appCss from "@/styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "SSO Admin" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  // Guard for every page (the /auth/* endpoints are server routes and never reach the router).
  // UX only: the admin API is the enforcement point. Login is a server route => full reload.
  beforeLoad: ({ location }) =>
    safely("root beforeLoad", async () => {
      const viewer = await getViewer();
      if (!viewer) {
        throw redirect({
          href: `/auth/login?returnTo=${encodeURIComponent(location.href)}`,
          reloadDocument: true,
        });
      }
      return { viewer };
    }),
  loader: () => safely("root loader", () => getUiPrefs()),
  // Prefs change only through this tab's own toggles (kept in client state): never refetch.
  staleTime: Infinity,
  shellComponent: RootDocument,
  component: RootLayout,
  errorComponent: RouteError,
  notFoundComponent: NotFound,
  pendingComponent: PagePending,
});

function RootDocument({ children }: { children: ReactNode }) {
  const theme = Route.useLoaderData({ select: (d) => d?.theme }) ?? "system";
  return (
    <ThemeProvider initial={theme}>
      <Html>
        <head>
          <HeadContent />
        </head>
        <body>
          {children}
          <Scripts />
        </body>
      </Html>
    </ThemeProvider>
  );
}

function Html({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  return (
    <html lang="en" className={themeClass(theme)}>
      {children}
    </html>
  );
}

function RootLayout() {
  const sidebarOpen = Route.useLoaderData({ select: (d) => d?.sidebarOpen ?? true });
  const { viewer } = Route.useRouteContext();
  const { theme } = useTheme();
  return (
    <AppLayout sidebarOpen={sidebarOpen} viewer={viewer}>
      {isAdmin(viewer) ? <Outlet /> : <Forbidden />}
      <Toaster theme={theme} />
    </AppLayout>
  );
}
