import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import ErrorPage from "../src/routes/ErrorPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderAt(path: string) {
  const router = createMemoryRouter([{ path: "/error", element: <ErrorPage /> }], {
    initialEntries: [path],
  });
  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });
}

describe("/error — safe OAuth error (DEBT-080)", () => {
  it("shows the mapped code + controlled message for a known error", async () => {
    await renderAt("/error?error=access_denied");
    expect(container.querySelector("[data-testid='error-code']")?.textContent).toBe("access_denied");
    expect(container.querySelector("[data-testid='error-message']")?.textContent).toBe(
      "Sign-in was denied.",
    );
  });

  it("never echoes error_description verbatim", async () => {
    const xss = encodeURIComponent("<img src=x onerror=alert(1)>");
    await renderAt(`/error?error=access_denied&error_description=${xss}`);
    const html = container.innerHTML;
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("alert(1)");
  });

  it("collapses an unknown/injection code to unknown_error", async () => {
    await renderAt("/error?error=%3Cscript%3E");
    expect(container.querySelector("[data-testid='error-code']")?.textContent).toBe("unknown_error");
    expect(container.innerHTML).not.toContain("<script>");
  });

  it("handles a missing error param", async () => {
    await renderAt("/error");
    expect(container.querySelector("[data-testid='error-code']")?.textContent).toBe("unknown_error");
  });
});