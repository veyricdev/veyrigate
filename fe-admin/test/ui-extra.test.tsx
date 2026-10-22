// Tester (run 41): extra a11y / error-exposure checks on the real root route (real shell).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "@/routeTree.gen";
import { getUiPrefs } from "@/features/theme/ui-prefs";

vi.mock("@/features/theme/ui-prefs", () => ({ getUiPrefs: vi.fn() }));
const prefs = vi.mocked(getUiPrefs);

function renderAt(path: string) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
  return render(<RouterProvider router={router} />);
}

// Braces matter: a function returned from beforeEach is run by vitest as a teardown.
beforeEach(() => {
  prefs.mockResolvedValue({ theme: "light", sidebarOpen: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  document.documentElement.className = "";
});

describe("a11y", () => {
  it("skip link target is a programmatically focusable <main id=main>, the only main landmark", async () => {
    renderAt("/");
    const main = await screen.findByRole("main");
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(main.getAttribute("tabindex")).toBe("-1");
    const skip = screen.getByRole("link", { name: "Skip to main content" });
    expect(skip.getAttribute("href")).toBe(`#${main.id}`);
  });

  it("the second Tab stop is past the skip link (skip link is not a focus trap)", async () => {
    const user = userEvent.setup();
    renderAt("/");
    await screen.findByRole("main");
    await user.tab();
    await user.tab();
    expect((document.activeElement as HTMLElement).textContent).not.toBe("Skip to main content");
    expect(document.activeElement).not.toBe(document.body);
  });

  it("no nav item is aria-current on the 404 page", async () => {
    renderAt("/does-not-exist");
    await screen.findByRole("heading", { name: "Page not found" });
    const nav = screen.getByRole("navigation", { name: "Main" });
    const link = within(nav).getByRole("link", { name: "Dashboard" });
    expect(link.hasAttribute("aria-current")).toBe(false);
    expect(screen.getByRole("link", { name: "Back to dashboard" }).getAttribute("href")).toBe("/");
  });

  it("aria-current=page is on exactly one nav link on /", async () => {
    renderAt("/");
    await screen.findByRole("main");
    const nav = screen.getByRole("navigation", { name: "Main" });
    const current = within(nav).getAllByRole("link").filter((a) => a.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
  });

  it("every button in the header has an accessible name", async () => {
    renderAt("/");
    await screen.findByRole("main");
    const header = document.querySelector("header")!;
    for (const b of within(header).getAllByRole("button")) {
      expect((b.getAttribute("aria-label") ?? b.textContent ?? "").trim()).not.toBe("");
    }
    expect(within(header).getByRole("button", { name: /change theme \(current: light\)/i })).toBeTruthy();
  });
});

describe("error page exposure (production)", () => {
  it("canary from the error message/stack is nowhere in the document, not even attributes", async () => {
    vi.stubEnv("DEV", false);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const canary = "canary-upstream-detail-51d2";
    const err = new Error(canary);
    err.stack = `Error: ${canary}\n    at secretFn (/srv/${canary}.js:1:1)`;
    prefs.mockRejectedValue(err);
    renderAt("/");
    await screen.findByRole("alert");
    expect(document.documentElement.outerHTML).not.toContain(canary);
    expect(document.title).not.toContain(canary);
  });

  it("error component offers a working retry (re-runs the loader)", async () => {
    vi.stubEnv("DEV", false);
    vi.spyOn(console, "error").mockImplementation(() => {});
    prefs.mockRejectedValueOnce(new Error("transient"));
    const user = userEvent.setup();
    renderAt("/");
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeTruthy();
    expect(prefs.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
