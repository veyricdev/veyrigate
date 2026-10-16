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

import Tokens from "../src/routes/Tokens";

const CLAIMS = {
  iss: "http://localhost:4000",
  sub: "user-123",
  aud: "fe-sso-test",
  exp: 1_700_000_000,
  iat: 1_699_999_000,
};

const AT = "at-secret-should-never-render";
const ID = "id-token-should-never-render";
const RT = "rt-secret-should-never-render";

function session(overrides: Partial<Session> = {}): Session {
  return {
    accessToken: AT,
    idToken: ID,
    refreshToken: RT,
    claims: CLAIMS,
    accessTokenExpiresAt: Date.now() + 90_000,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.useRealTimers();
});
function render() {
  act(() => root.render(<MemoryRouter><Tokens /></MemoryRouter>));
}

describe("/tokens — metadata only (Q-24.3, Task 2)", () => {
  it("shows presence of access/ID/refresh + token type Bearer", () => {
    tokensGet.mockReturnValue(session({ accessTokenExpiresAt: Date.now() + 90_000 }));
    render();
    expect(container.querySelector("[data-testid='meta-has-access']")?.textContent).toBe("present");
    expect(container.querySelector("[data-testid='meta-has-id']")?.textContent).toBe("present");
    expect(container.querySelector("[data-testid='meta-has-refresh']")?.textContent).toBe(
      "present",
    );
    expect(container.querySelector("[data-testid='meta-token-type']")?.textContent).toBe("Bearer");
  });

  it("reports refresh token absent when the session has none", () => {
    tokensGet.mockReturnValue(session({ refreshToken: undefined, accessTokenExpiresAt: Date.now() + 90_000 }));
    render();
    expect(container.querySelector("[data-testid='meta-has-refresh']")?.textContent).toBe("absent");
  });

  it("renders a countdown that ticks down each second", () => {
    tokensGet.mockReturnValue(session({ accessTokenExpiresAt: Date.now() + 90_000 }));
    render();
    expect(container.querySelector("[data-testid='meta-countdown']")?.textContent).toBe("01:30");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.querySelector("[data-testid='meta-countdown']")?.textContent).toBe("01:29");
  });

  it("shows `expired` once the deadline passes", () => {
    tokensGet.mockReturnValue(session({ accessTokenExpiresAt: Date.now() - 1 }));
    render();
    expect(container.querySelector("[data-testid='meta-countdown']")?.textContent).toBe("expired");
  });

  it("renders decoded ID-token claims", () => {
    tokensGet.mockReturnValue(session({ accessTokenExpiresAt: Date.now() + 90_000 }));
    render();
    expect(container.querySelector("[data-testid='token-claim-sub']")?.textContent).toBe(
      "user-123",
    );
    expect(container.querySelector("[data-testid='token-claim-aud']")?.textContent).toBe(
      "fe-sso-test",
    );
  });

  it("never renders raw token strings and never the access-token payload", () => {
    tokensGet.mockReturnValue(session({ accessTokenExpiresAt: Date.now() + 90_000 }));
    render();
    const html = container.innerHTML;
    expect(html).not.toContain(AT);
    expect(html).not.toContain(ID);
    expect(html).not.toContain(RT);
  });

  it("defensive fallback when reached without a session", () => {
    tokensGet.mockReturnValue(null);
    render();
    expect(container.querySelector("[data-testid='token-metadata']")).toBeNull();
    expect(container.textContent).toContain("Not signed in");
  });
});