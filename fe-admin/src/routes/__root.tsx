import type { ReactNode } from "react";
import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { AppLayout } from "@/components/layout/app-layout";
import { NotFound, PagePending, RouteError } from "@/components/feedback/route-states";
import { Toaster } from "@/components/ui/sonner";
import { themeClass } from "@/features/theme/theme";
import { ThemeProvider, useTheme } from "@/features/theme/theme-provider";
import { getUiPrefs } from "@/features/theme/ui-prefs";
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
  loader: () => getUiPrefs(),
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
  const { theme } = useTheme();
  return (
    <AppLayout sidebarOpen={sidebarOpen}>
      <Outlet />
      <Toaster theme={theme} />
    </AppLayout>
  );
}
