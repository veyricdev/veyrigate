import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { Session } from "../src/oidc/tokenStore";

// Mock the whole OIDC client so the router's loaders are deterministic and env.app is never read.
const {
  tokensGet,
  finishLogin,
  consumeReturnTo,
  startLogin,
  logout,
  consumeLogout,
  isAudProbePending,
  consumeSilentRestoreFlag,
} = vi.hoisted(() => ({
  tokensGet: vi.fn<() => Session | null>(),
  finishLogin: vi.fn(),
  consumeReturnTo: vi.fn<() => string>(),
  startLogin: vi.fn(),
  logout: vi.fn(),
  consumeLogout: vi.fn(),
  isAudProbePending: vi.fn<() => boolean>(),
  consumeSilentRestoreFlag: vi.fn<() => boolean>(),
}));
vi.mock("../src/oidc/client", () => ({
  tokens: { get: tokensGet, set: vi.fn(), clear: vi.fn() },
  finishLogin,
  consumeReturnTo,
  startLogin,
  logout,
  consumeLogout,
  isAudProbePending,
  consumeSilentRestoreFlag,
  finishAudProbe: vi.fn(),
  restoreSessionSilently: vi.fn(),
  startAudProbe: vi.fn(),
  takeProbeResult: vi.fn().mockReturnValue(null),
  demoApiUrl: () => "http://localhost:4000/demo/me",
  userinfoUrl: () => "http://localhost:4000/userinfo",
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Import AFTER the mock so the router binds to the mocked client.
const { routes } = await import("../src/router");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  consumeLogout.mockReturnValue({ handled: false, confirmed: false, cleanedSearch: "" });
  startLogin.mockResolvedValue(undefined);
  isAudProbePending.mockReturnValue(false);
  consumeSilentRestoreFlag.mockReturnValue(false);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

/** Render the real route table at `initialPath` and wait a tick for loaders to settle. */
async function renderAt(initialPath: string) {
  const router = createMemoryRouter(routes, { initialEntries: [initialPath] });
  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });
  return router;
}

describe("route guard (fail-closed redirect to /login)", () => {
  it("anonymous visit to /profile redirects to /login with returnTo", async () => {
    tokensGet.mockReturnValue(null);
    const router = await renderAt("/profile");
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search).toBe(`?returnTo=${encodeURIComponent("/profile")}`);
  });

  it("anonymous visit to /tokens preserves path+query in returnTo", async () => {
    tokensGet.mockReturnValue(null);
    const router = await renderAt("/tokens?x=1");
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search).toBe(`?returnTo=${encodeURIComponent("/tokens?x=1")}`);
  });

  it("signed-in visit to /profile renders the page (no redirect)", async () => {
    tokensGet.mockReturnValue({
      accessToken: "a",
      idToken: "i",
      claims: { iss: "x", sub: "user-9", aud: "c", exp: 0, iat: 0 },
      accessTokenExpiresAt: 0,
    });
    const router = await renderAt("/profile");
    expect(router.state.location.pathname).toBe("/profile");
    expect(container.querySelector("[data-testid='profile-sub']")?.textContent).toBe("user-9");
  });
});

describe("/callback loader", () => {
  it("on success redirects to the validated returnTo", async () => {
    // After the exchange the session exists, so the guard on the destination lets it render.
    finishLogin.mockResolvedValue(undefined);
    tokensGet.mockReturnValue({
      accessToken: "a",
      idToken: "i",
      claims: { iss: "x", sub: "user-1", aud: "c", exp: 0, iat: 0 },
      accessTokenExpiresAt: Date.now() + 60_000,
    });
    consumeReturnTo.mockReturnValue("/tokens");
    const router = await renderAt("/callback?code=abc&state=s");
    expect(finishLogin).toHaveBeenCalledOnce();
    expect(router.state.location.pathname).toBe("/tokens");
  });

  it("on an error response redirects to the safe /error page (no code exchange)", async () => {
    tokensGet.mockReturnValue(null);
    const router = await renderAt("/callback?error=access_denied&error_description=evil");
    expect(finishLogin).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe("/error");
    expect(router.state.location.search).toBe("?error=access_denied");
  });
});