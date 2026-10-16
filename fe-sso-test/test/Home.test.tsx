import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import type { Session } from "../src/oidc/tokenStore";

// Mock the OIDC client so importing Home never triggers env.app's eager `parseEnv(import.meta.env)`
// and so we can control the session + logout-landing outcome. `vi.hoisted` keeps the mock fns
// available to the hoisted `vi.mock` factory.
const { tokensGet, consumeLogout } = vi.hoisted(() => ({
  tokensGet: vi.fn<() => Session | null>(),
  consumeLogout: vi.fn(),
}));
vi.mock("../src/oidc/client", () => ({
  tokens: { get: tokensGet, set: vi.fn(), clear: vi.fn() },
  startLogin: vi.fn(),
  logout: vi.fn(),
  consumeLogout,
}));

// Opt into React's act() testing environment so state updates in effects are flushed and warning-
// free under the DOM test runner.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import Home from "../src/routes/Home";

const CLAIMS = {
  iss: "http://localhost:4000",
  sub: "user-123",
  aud: "fe-sso-test",
  exp: 1_700_000_000,
  iat: 1_699_999_000,
};

function session(overrides: Partial<Session> = {}): Session {
  return {
    accessToken: "at-secret-should-never-render",
    idToken: "id-token-should-never-render",
    refreshToken: "rt-secret-should-never-render",
    claims: CLAIMS,
    accessTokenExpiresAt: 0,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  consumeLogout.mockReturnValue({ handled: false, confirmed: false, cleanedSearch: "" });
  window.history.replaceState(null, "", "/");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function render() {
  act(() => root.render(<MemoryRouter><Home /></MemoryRouter>));
}

describe("Home claims panel (X1 'display claims')", () => {
  it("renders sub/iss/aud/exp from session.claims under a stable claims testid", () => {
    tokensGet.mockReturnValue(session());
    render();
    const claims = container.querySelector("[data-testid='claims']");
    expect(claims).not.toBeNull();
    expect(container.querySelector("[data-testid='claim-sub']")?.textContent).toBe("user-123");
    expect(container.querySelector("[data-testid='claim-iss']")?.textContent).toBe(
      "http://localhost:4000",
    );
    expect(container.querySelector("[data-testid='claim-aud']")?.textContent).toBe("fe-sso-test");
    // exp is rendered as ISO-8601 derived from epoch-seconds, not the raw number.
    expect(container.querySelector("[data-testid='claim-exp']")?.textContent).toBe(
      new Date(CLAIMS.exp * 1000).toISOString(),
    );
  });

  it("renders a multi-valued aud as a comma-joined string", () => {
    tokensGet.mockReturnValue(session({ claims: { ...CLAIMS, aud: ["fe-sso-test", "other"] } }));
    render();
    expect(container.querySelector("[data-testid='claim-aud']")?.textContent).toBe(
      "fe-sso-test, other",
    );
  });

  it("never renders access/refresh/id tokens in the DOM (exposure budget)", () => {
    tokensGet.mockReturnValue(session());
    render();
    const html = container.innerHTML;
    expect(html).not.toContain("at-secret-should-never-render");
    expect(html).not.toContain("rt-secret-should-never-render");
    expect(html).not.toContain("id-token-should-never-render");
  });

  it("shows the anonymous view (no claims panel) when signed out", () => {
    tokensGet.mockReturnValue(null);
    render();
    expect(container.querySelector("[data-testid='claims']")).toBeNull();
    expect(container.textContent).toContain("Not signed in");
  });
});

describe("Home post-logout landing (DEBT-079)", () => {
  it("confirmed state: shows signed-out notice and strips state from the URL", () => {
    tokensGet.mockReturnValue(null);
    window.history.replaceState(null, "", "/?state=abc");
    consumeLogout.mockReturnValue({ handled: true, confirmed: true, cleanedSearch: "" });
    render();
    expect(consumeLogout).toHaveBeenCalledWith("?state=abc");
    expect(container.querySelector("[data-testid='signed-out']")).not.toBeNull();
    expect(window.location.search).toBe("");
  });

  it("wrong/missing state: no success notice, URL still cleaned (neutral, fail-closed)", () => {
    tokensGet.mockReturnValue(null);
    window.history.replaceState(null, "", "/?state=wrong");
    consumeLogout.mockReturnValue({ handled: true, confirmed: false, cleanedSearch: "" });
    render();
    expect(container.querySelector("[data-testid='signed-out']")).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("ordinary visit (no state): does not consume state and leaves the URL alone", () => {
    tokensGet.mockReturnValue(null);
    window.history.replaceState(null, "", "/?foo=bar");
    consumeLogout.mockReturnValue({ handled: false, confirmed: false, cleanedSearch: "?foo=bar" });
    render();
    expect(container.querySelector("[data-testid='signed-out']")).toBeNull();
    expect(window.location.search).toBe("?foo=bar");
  });
});
