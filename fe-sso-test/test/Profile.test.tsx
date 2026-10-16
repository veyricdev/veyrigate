import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import type { Session } from "../src/oidc/tokenStore";

const { tokensGet } = vi.hoisted(() => ({ tokensGet: vi.fn<() => Session | null>() }));
vi.mock("../src/oidc/client", () => ({
  tokens: { get: tokensGet, set: vi.fn(), clear: vi.fn() },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import Profile from "../src/routes/Profile";

const CLAIMS = {
  iss: "http://localhost:4000",
  sub: "user-123",
  aud: "fe-sso-test",
  exp: 1_700_000_000,
  iat: 1_699_999_000,
  nonce: "n-abc",
  email: "a@b.test",
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
  act(() => root.render(<MemoryRouter><Profile /></MemoryRouter>));
}

describe("/profile — decoded ID-token claims (Task 2)", () => {
  it("renders sub/iss/aud/exp/iat and nonce from session.claims", () => {
    tokensGet.mockReturnValue(session());
    render();
    expect(container.querySelector("[data-testid='profile-sub']")?.textContent).toBe("user-123");
    expect(container.querySelector("[data-testid='profile-iss']")?.textContent).toBe(
      "http://localhost:4000",
    );
    expect(container.querySelector("[data-testid='profile-aud']")?.textContent).toBe("fe-sso-test");
    expect(container.querySelector("[data-testid='profile-exp']")?.textContent).toBe(
      new Date(CLAIMS.exp * 1000).toISOString(),
    );
    expect(container.querySelector("[data-testid='profile-iat']")?.textContent).toBe(
      new Date(CLAIMS.iat * 1000).toISOString(),
    );
    expect(container.querySelector("[data-testid='profile-nonce']")?.textContent).toBe("n-abc");
  });

  it("renders extra claims (e.g. email) in the extra panel", () => {
    tokensGet.mockReturnValue(session());
    render();
    const extra = container.querySelector("[data-testid='profile-extra']");
    expect(extra?.textContent).toContain("email");
    expect(extra?.textContent).toContain("a@b.test");
  });

  it("joins a multi-valued aud", () => {
    tokensGet.mockReturnValue(session({ claims: { ...CLAIMS, aud: ["fe-sso-test", "other"] } }));
    render();
    expect(container.querySelector("[data-testid='profile-aud']")?.textContent).toBe(
      "fe-sso-test, other",
    );
  });

  it("never renders raw token strings (exposure budget)", () => {
    tokensGet.mockReturnValue(session());
    render();
    const html = container.innerHTML;
    expect(html).not.toContain("at-secret-should-never-render");
    expect(html).not.toContain("rt-secret-should-never-render");
    expect(html).not.toContain("id-token-should-never-render");
  });

  it("defensive fallback when reached without a session", () => {
    tokensGet.mockReturnValue(null);
    render();
    expect(container.querySelector("[data-testid='profile-claims']")).toBeNull();
    expect(container.textContent).toContain("Not signed in");
  });
});