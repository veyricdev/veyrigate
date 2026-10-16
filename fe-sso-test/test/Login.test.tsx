import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";

const { startLogin } = vi.hoisted(() => ({ startLogin: vi.fn<(r?: string) => Promise<void>>() }));
vi.mock("../src/oidc/client", () => ({ startLogin }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import Login from "../src/routes/Login";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  startLogin.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function renderAt(path: string) {
  const router = createMemoryRouter([{ path: "/login", element: <Login /> }], {
    initialEntries: [path],
  });
  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });
}

describe("/login — start flow with sanitized returnTo (Task 2)", () => {
  it("passes a safe returnTo straight through to startLogin", async () => {
    await renderAt(`/login?returnTo=${encodeURIComponent("/profile")}`);
    expect(startLogin).toHaveBeenCalledWith("/profile");
  });

  it("sanitizes an unsafe returnTo to `/` before starting login", async () => {
    await renderAt(`/login?returnTo=${encodeURIComponent("https://evil")}`);
    expect(startLogin).toHaveBeenCalledWith("/");
  });

  it("defaults to `/` when no returnTo is supplied", async () => {
    await renderAt("/login");
    expect(startLogin).toHaveBeenCalledWith("/");
  });

  it("renders a fail-closed error when startLogin rejects", async () => {
    startLogin.mockRejectedValue(new Error("discovery failed"));
    await renderAt("/login");
    // Allow the rejected promise microtask + state update to flush.
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector("[data-testid='login-error']")?.textContent).toContain(
      "discovery failed",
    );
  });
});