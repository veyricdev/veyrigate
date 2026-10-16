import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import type { Session } from "../src/oidc/tokenStore";
import type { LabResult } from "../src/oidc/lab";
import { TokenEndpointError } from "../src/oidc/token-exchange";

const { tokensGet, refresh, replayRefreshToken, takeLabResult, startLabScenario, startStateTamper } =
  vi.hoisted(() => ({
    tokensGet: vi.fn<() => Session | null>(),
    refresh: vi.fn(),
    replayRefreshToken: vi.fn(),
    takeLabResult: vi.fn<() => LabResult | null>(),
    startLabScenario: vi.fn(),
    startStateTamper: vi.fn(),
  }));
vi.mock("../src/oidc/client", () => ({
  tokens: { get: tokensGet, set: vi.fn(), clear: vi.fn() },
  refresh,
  replayRefreshToken,
  takeLabResult,
  startLabScenario,
  startStateTamper,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import Lab from "../src/routes/Lab";

const OLD_RT = "rt-old-secret-should-never-render";
const NEW_RT = "rt-new-secret-should-never-render";

function session(refreshToken: string): Session {
  return {
    accessToken: "at-secret-should-never-render",
    idToken: "id-secret-should-never-render",
    refreshToken,
    claims: { iss: "http://localhost:4000", sub: "u1", aud: "c", exp: 0, iat: 0 },
    accessTokenExpiresAt: 0,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  takeLabResult.mockReturnValue(null);
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
  act(() =>
    root.render(
      <MemoryRouter>
        <Lab />
      </MemoryRouter>,
    ),
  );
}

const verdict = (id: string) => container.querySelector(`[data-testid='${id}']`)?.textContent ?? "";

describe("/lab refresh replay panel (Task 2)", () => {
  it("scores the three steps green against a correct IdP and never renders/stores a token", async () => {
    let current: Session | null = session(OLD_RT);
    tokensGet.mockImplementation(() => current);
    refresh
      .mockImplementationOnce(async () => {
        current = session(NEW_RT);
      })
      .mockImplementationOnce(async () => {
        current = null; // the store clears itself on a failed refresh
        throw new TokenEndpointError("invalid_grant");
      });
    replayRefreshToken.mockRejectedValue(new TokenEndpointError("invalid_grant"));

    render();
    await act(async () => {
      (container.querySelector("[data-testid='lab-replay-run']") as HTMLButtonElement).click();
    });

    expect(replayRefreshToken).toHaveBeenCalledWith(OLD_RT);
    for (const step of [1, 2, 3]) expect(verdict(`lab-replay-step-${step}`)).toMatch(/^PASS/);
    expect(container.querySelector("[data-testid='lab-replay-note']")).not.toBeNull();

    const html = container.innerHTML;
    for (const secret of [OLD_RT, NEW_RT, "at-secret", "id-secret"]) {
      expect(html).not.toContain(secret);
      expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(secret);
      expect(JSON.stringify({ ...window.localStorage })).not.toContain(secret);
    }
  });

  it("an IdP that accepts the replay is shown red", async () => {
    let current: Session | null = session(OLD_RT);
    tokensGet.mockImplementation(() => current);
    refresh.mockImplementation(async () => {
      current = session(NEW_RT);
    });
    replayRefreshToken.mockResolvedValue(undefined);

    render();
    await act(async () => {
      (container.querySelector("[data-testid='lab-replay-run']") as HTMLButtonElement).click();
    });
    expect(verdict("lab-replay-step-2")).toMatch(/^FAIL/);
    expect(verdict("lab-replay-step-3")).toMatch(/^FAIL/);
  });
});

describe("/lab one-shot redirect results (Task 3)", () => {
  it("shows the recorded /authorize scenario result on its row", () => {
    tokensGet.mockReturnValue(null);
    takeLabResult.mockReturnValue({
      scenario: "pkce-plain",
      outcome: "error",
      error: "invalid_request",
      issOk: true,
      stateOk: true,
      pass: true,
    });
    render();
    expect(verdict("lab-result-pkce-plain")).toBe("PASS — error=invalid_request, state ok, iss ok");
    expect(takeLabResult).toHaveBeenCalledOnce();
  });

  it("shows the state-tamper verdict", () => {
    tokensGet.mockReturnValue(null);
    takeLabResult.mockReturnValue({ scenario: "state-tamper", outcome: "rejected", pass: true });
    render();
    expect(verdict("lab-result-state-tamper")).toMatch(/^PASS — callback rejected: state mismatch/);
  });

  it("a scenario Run button starts that scenario", () => {
    tokensGet.mockReturnValue(null);
    startLabScenario.mockResolvedValue(undefined);
    render();
    act(() => (container.querySelector("[data-testid='lab-run-no-nonce']") as HTMLButtonElement).click());
    expect(startLabScenario).toHaveBeenCalledWith("no-nonce");
  });

  it("the state-tamper Run button starts the tamper flow", () => {
    tokensGet.mockReturnValue(null);
    startStateTamper.mockResolvedValue(undefined);
    render();
    act(() => (container.querySelector("[data-testid='lab-run-state-tamper']") as HTMLButtonElement).click());
    expect(startStateTamper).toHaveBeenCalledOnce();
  });
});
