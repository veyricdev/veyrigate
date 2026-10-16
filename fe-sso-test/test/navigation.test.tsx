import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { Session } from "../src/oidc/tokenStore";

// DEBT-101: internal navigation must be client-side (`<Link>`), so the in-memory session survives.
// A full-page `<a href>` would reload the SPA, drop the session and bounce through /authorize.
const { tokensGet, startLogin } = vi.hoisted(() => ({
  tokensGet: vi.fn<() => Session | null>(),
  startLogin: vi.fn(),
}));
vi.mock("../src/oidc/client", () => ({
  tokens: { get: tokensGet, set: vi.fn(), clear: vi.fn() },
  startLogin,
  finishLogin: vi.fn(),
  consumeReturnTo: vi.fn(),
  logout: vi.fn(),
  consumeLogout: vi.fn().mockReturnValue({ handled: false, confirmed: false, cleanedSearch: "" }),
  isAudProbePending: vi.fn().mockReturnValue(false),
  consumeSilentRestoreFlag: vi.fn().mockReturnValue(false),
  finishAudProbe: vi.fn(),
  restoreSessionSilently: vi.fn(),
  startAudProbe: vi.fn(),
  takeProbeResult: vi.fn().mockReturnValue(null),
  demoApiUrl: () => "http://localhost:4000/demo/me",
  userinfoUrl: () => "http://localhost:4000/userinfo",
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { routes } = await import("../src/router");

const SESSION: Session = {
  accessToken: "a",
  idToken: "i",
  claims: { iss: "http://localhost:4000", sub: "user-nav", aud: "c", exp: 0, iat: 0 },
  accessTokenExpiresAt: Date.now() + 60_000,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  tokensGet.mockReturnValue(SESSION);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

/** Click the link with the given visible text and let the router settle. */
async function clickLink(text: string) {
  const link = Array.from(container.querySelectorAll("a")).find((a) => a.textContent === text);
  if (!link) throw new Error(`link "${text}" not found`);
  await act(async () => {
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
}

describe("internal navigation keeps the in-memory session (DEBT-101)", () => {
  it("Home → Profile → Home → Tokens → Home → API test stays client-side, never re-authorizes", async () => {
    const router = createMemoryRouter(routes, { initialEntries: ["/"] });
    await act(async () => {
      root.render(<RouterProvider router={router} />);
    });

    await clickLink("Profile");
    expect(router.state.location.pathname).toBe("/profile");
    expect(container.querySelector("[data-testid='profile-sub']")?.textContent).toBe("user-nav");

    await clickLink("Home");
    expect(router.state.location.pathname).toBe("/");

    await clickLink("Tokens");
    expect(router.state.location.pathname).toBe("/tokens");
    expect(container.querySelector("[data-testid='token-metadata']")).not.toBeNull();

    await clickLink("Home");
    await clickLink("API test");
    expect(router.state.location.pathname).toBe("/api-test");
    expect(container.querySelector("[data-testid='api-test-actions']")).not.toBeNull();

    await clickLink("Home");
    expect(router.state.location.pathname).toBe("/");

    // The guard never bounced to /login and no new authorize flow was started.
    expect(startLogin).not.toHaveBeenCalled();
  });
});
