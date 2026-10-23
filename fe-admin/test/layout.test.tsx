import { useLayoutEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "@/routeTree.gen";
import { IdleQueries } from "./support/idle-queries";
import { getUiPrefs } from "@/features/theme/ui-prefs";
import { getViewer } from "@/features/auth/viewer";
import { themeClass } from "@/features/theme/theme";
import { ThemeProvider, useTheme } from "@/features/theme/theme-provider";
import { Route as RootRoute } from "@/routes/__root";

// The real server fn needs the Start compiler/runtime; the root loader only needs its result.
vi.mock("@/features/theme/ui-prefs", () => ({ getUiPrefs: vi.fn() }));
const prefs = vi.mocked(getUiPrefs);
// Root guard (run 42): signed-in admin unless a test says otherwise.
vi.mock("@/features/auth/viewer", () => ({ getViewer: vi.fn() }));
const viewer = vi.mocked(getViewer);
// Browser build of the route boundary: the client branch passes errors through (the server branch,
// which sanitises, is covered by error-boundary.test.tsx). Uncompiled, createIsomorphicFn would
// always pick the server branch.
vi.mock("@/lib/route-boundary", () => ({ safely: (_where: string, fn: () => Promise<unknown>) => fn() }));

type Shell = (props: { children: ReactNode }) => ReactNode;
const rootOptions = RootRoute.options as { shellComponent?: Shell };
const realShell = rootOptions.shellComponent;

// happy-dom limitation: with the real shell, React 19 renders <html>/<body> as singletons and a
// Radix portal into that <body> spins forever. Tests that open a portal (theme menu) swap in this
// shell: same ThemeProvider, and the <html> class is mirrored with the same themeClass(). The real
// shell's <html> class is asserted by the server-theme tests below and in the browser smoke.
function PortalSafeShell({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider initial="light">
      <HtmlClassMirror />
      {children}
    </ThemeProvider>
  );
}
function HtmlClassMirror() {
  const { theme } = useTheme();
  useLayoutEffect(() => {
    document.documentElement.className = themeClass(theme) ?? "";
  }, [theme]);
  return null;
}

function renderAt(path: string, { portalSafe = false } = {}) {
  rootOptions.shellComponent = portalSafe ? PortalSafeShell : realShell;
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    Wrap: IdleQueries,
  });
  return render(<RouterProvider router={router} />);
}

beforeEach(() => {
  prefs.mockResolvedValue({ theme: "light", sidebarOpen: true });
  viewer.mockResolvedValue({ sub: "u1", email: "admin@example.com", roles: ["super_admin"], tenantId: "t1" });
  document.cookie = "theme=; Max-Age=0; Path=/";
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  document.documentElement.className = "";
});

describe("app layout", () => {
  it("renders the main navigation and the main landmark", async () => {
    renderAt("/");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Dashboard" })).toBeTruthy();
    const main = screen.getByRole("main");
    expect(main.id).toBe("main");
    expect(within(main).getByRole("heading", { name: "Dashboard" })).toBeTruthy();
  });

  it("has a skip link to #main as the first focusable element", async () => {
    const user = userEvent.setup();
    renderAt("/");
    await screen.findByRole("main");
    await user.tab();
    const focused = document.activeElement as HTMLAnchorElement;
    expect(focused.tagName).toBe("A");
    expect(focused.getAttribute("href")).toBe("#main");
    expect(focused.textContent).toBe("Skip to main content");
  });

  it("marks the current nav item with aria-current=page", async () => {
    renderAt("/");
    const link = await screen.findByRole("link", { name: "Dashboard" });
    expect(link.getAttribute("aria-current")).toBe("page");
  });

  it("gives the sidebar toggle an accessible name", async () => {
    renderAt("/");
    expect(await screen.findByRole("button", { name: /toggle sidebar/i })).toBeTruthy();
  });

  it("renders the 404 component for an unknown route", async () => {
    renderAt("/does-not-exist");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
  });
});

describe("theme", () => {
  it("applies the server-provided theme class to <html>", async () => {
    prefs.mockResolvedValue({ theme: "dark", sidebarOpen: true });
    renderAt("/");
    await screen.findByRole("main");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("toggles the dark class from the labelled theme menu and persists it in a cookie", async () => {
    const user = userEvent.setup();
    renderAt("/", { portalSafe: true });
    const trigger = await screen.findByRole("button", { name: /change theme/i });
    expect(trigger.getAttribute("aria-label")).toMatch(/current: light/);
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    await user.click(trigger);
    await user.click(await screen.findByRole("menuitemradio", { name: "Dark" }));

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.cookie).toContain("theme=dark");
    expect(screen.getByRole("button", { name: /change theme/i }).getAttribute("aria-label")).toMatch(
      /current: dark/,
    );
  });

  it("leaves <html> without a theme class for system", async () => {
    prefs.mockResolvedValue({ theme: "system", sidebarOpen: true });
    renderAt("/");
    await screen.findByRole("main");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.classList.contains("light")).toBe(false);
  });
});

describe("error component", () => {
  it("never shows the error message in production", async () => {
    vi.stubEnv("DEV", false);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const canary = "canary-error-detail-7f3a";
    prefs.mockRejectedValue(new Error(canary));
    renderAt("/");
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("heading", { name: "Something went wrong" })).toBeTruthy();
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(document.body.textContent).not.toContain(canary);
  });

  it("shows the message in dev to help debugging", async () => {
    vi.stubEnv("DEV", true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    prefs.mockRejectedValue(new Error("dev-visible-detail"));
    renderAt("/");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("dev-visible-detail");
  });
});
