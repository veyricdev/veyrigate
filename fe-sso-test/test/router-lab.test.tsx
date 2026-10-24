import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { Session } from "../src/oidc/tokenStore";
import { TAMPERED_STATE } from "../src/oidc/lab";

const { tokensGet, finishLogin, consumeReturnTo, finishLabCallback, finishStateTamper } = vi.hoisted(() => ({
  tokensGet: vi.fn<() => Session | null>(),
  finishLogin: vi.fn(),
  consumeReturnTo: vi.fn<() => string>(),
  finishLabCallback: vi.fn(),
  finishStateTamper: vi.fn(),
}));
vi.mock("../src/oidc/client", () => ({
  tokens: { get: tokensGet, set: vi.fn(), clear: vi.fn() },
  finishLogin,
  consumeReturnTo,
  finishLabCallback,
  finishStateTamper,
  startLogin: vi.fn(),
  logout: vi.fn(),
  consumeLogout: vi.fn().mockReturnValue({ handled: false, confirmed: false, cleanedSearch: "" }),
  isAudProbePending: vi.fn().mockReturnValue(false),
  consumeSilentRestoreFlag: vi.fn().mockReturnValue(false),
  finishAudProbe: vi.fn(),
  restoreSessionSilently: vi.fn(),
  startAudProbe: vi.fn(),
  takeProbeResult: vi.fn().mockReturnValue(null),
  refresh: vi.fn(),
  replayRefreshToken: vi.fn(),
  startLabScenario: vi.fn(),
  startStateTamper: vi.fn(),
  takeLabResult: vi.fn().mockReturnValue(null),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { buildRoutes } = await import("../src/router");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.sessionStorage.clear();
  tokensGet.mockReturnValue(null);
  finishLogin.mockResolvedValue(undefined);
  finishStateTamper.mockResolvedValue({ scenario: "state-tamper", outcome: "rejected", pass: true });
  consumeReturnTo.mockReturnValue("/");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function renderAt(lab: boolean, path: string) {
  const router = createMemoryRouter(buildRoutes({ lab }), { initialEntries: [path] });
  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });
  // Let the lazy `/lab` module resolve.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return router;
}

function labTransient() {
  window.sessionStorage.setItem(
    "oidc:transient",
    JSON.stringify({ state: "s", nonce: "n", verifier: "v", createdAt: Date.now(), purpose: "lab", labScenario: "pkce-plain" }),
  );
}

describe("dev-only gate (F5)", () => {
  it("buildRoutes({lab:false}) has no /lab route", () => {
    expect(buildRoutes({ lab: false }).map((r) => r.path)).not.toContain("/lab");
    expect(buildRoutes({ lab: true }).map((r) => r.path)).toContain("/lab");
  });

  it("lab:false ignores a lab transient and a tamper flag (ordinary login path)", async () => {
    labTransient();
    window.sessionStorage.setItem("oidc:lab_expect", "state-tamper");
    await renderAt(false, `/callback?code=c&state=${TAMPERED_STATE}&iss=x`);
    expect(finishLabCallback).not.toHaveBeenCalled();
    expect(finishStateTamper).not.toHaveBeenCalled();
    expect(finishLogin).toHaveBeenCalledOnce();
  });
});

describe("/callback lab branches (lab:true)", () => {
  it("purpose:lab ⇒ recorded via finishLabCallback, never finishLogin, back to /lab", async () => {
    labTransient();
    const router = await renderAt(true, "/callback?error=invalid_request&state=s&iss=x");
    expect(finishLabCallback).toHaveBeenCalledOnce();
    expect(finishLogin).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/lab"));
  });

  it("purpose:lab with a code ⇒ still no exchange", async () => {
    labTransient();
    await renderAt(true, "/callback?code=c&state=s&iss=x");
    expect(finishLabCallback).toHaveBeenCalledOnce();
    expect(finishLogin).not.toHaveBeenCalled();
  });

  it("armed tamper flag + forged state ⇒ finishStateTamper, back to /lab", async () => {
    window.sessionStorage.setItem("oidc:lab_expect", "state-tamper");
    const router = await renderAt(true, `/callback?code=c&state=${TAMPERED_STATE}&iss=x`);
    expect(finishStateTamper).toHaveBeenCalledOnce();
    expect(finishLogin).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/lab"));
    expect(window.sessionStorage.getItem("oidc:lab_expect")).toBeNull();
  });

  it("ordinary login callback is unaffected", async () => {
    await renderAt(true, "/callback?code=c&state=s&iss=x");
    expect(finishLabCallback).not.toHaveBeenCalled();
    expect(finishStateTamper).not.toHaveBeenCalled();
    expect(finishLogin).toHaveBeenCalledOnce();
  });
});

describe("/lab is not route-guarded (F4)", () => {
  it("anonymous visit renders the lab with a sign-in link for the replay section", async () => {
    const router = await renderAt(true, "/lab");
    expect(router.state.location.pathname).toBe("/lab");
    const link = container.querySelector("[data-testid='lab-replay-signin'] a");
    expect(link?.getAttribute("href")).toBe("/login?returnTo=/lab");
    expect(container.querySelector("[data-testid='lab-replay-run']")).toBeNull();
  });
});
