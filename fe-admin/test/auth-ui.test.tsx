// Root guard + header + 403 page (run 42 Task 3/4) on the real route tree.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "@/routeTree.gen";
import { IdleQueries } from "./support/idle-queries";
import { getUiPrefs } from "@/features/theme/ui-prefs";
import { getViewer } from "@/features/auth/viewer";

vi.mock("@/features/theme/ui-prefs", () => ({ getUiPrefs: vi.fn() }));
vi.mock("@/features/auth/viewer", () => ({ getViewer: vi.fn() }));
const prefs = vi.mocked(getUiPrefs);
const viewer = vi.mocked(getViewer);
const admin = { sub: "u1", email: "admin@example.com", roles: ["tenant_admin"], tenantId: "t1" };

function renderAt(path: string) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }), Wrap: IdleQueries });
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  prefs.mockResolvedValue({ theme: "light", sidebarOpen: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("auth UI", () => {
  it("admin: header shows the email and a Sign out form POSTing to /auth/logout", async () => {
    viewer.mockResolvedValue(admin);
    renderAt("/");
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeTruthy();
    expect(screen.getByTestId("viewer-email").textContent).toBe("admin@example.com");
    const button = within(screen.getByRole("banner")).getByRole("button", { name: "Sign out" });
    const form = button.closest("form")!;
    expect(form.getAttribute("method")).toBe("post");
    expect(form.getAttribute("action")).toBe("/auth/logout");
  });

  it("email missing => the subject is shown instead", async () => {
    viewer.mockResolvedValue({ ...admin, email: null });
    renderAt("/");
    expect((await screen.findByTestId("viewer-email")).textContent).toBe("u1");
  });

  it("signed in without an admin role => 403 page with a sign-out button, no dashboard", async () => {
    viewer.mockResolvedValue({ ...admin, roles: [] });
    renderAt("/");
    expect(await screen.findByRole("heading", { name: "Access denied" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Dashboard" })).toBeNull();
    const main = screen.getByRole("main");
    expect(within(main).getByRole("button", { name: "Sign out" }).closest("form")!.getAttribute("action")).toBe(
      "/auth/logout",
    );
  });

  it("no session => redirect to the login server route with returnTo (full document load)", async () => {
    viewer.mockResolvedValue(null);
    const replace = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...original, replace } });
    try {
      renderAt("/clients?x=1");
      await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/auth/login?returnTo=%2Fclients%3Fx%3D1"));
      expect(screen.queryByRole("heading", { name: "Dashboard" })).toBeNull();
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: original });
    }
  });
});
