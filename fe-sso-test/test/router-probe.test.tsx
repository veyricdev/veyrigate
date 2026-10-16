import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { Session } from "../src/oidc/tokenStore";

const {
  tokensGet,
  finishLogin,
  consumeReturnTo,
  startLogin,
  logout,
  consumeLogout,
  isAudProbePending,
  finishAudProbe,
  restoreSessionSilently,
  consumeSilentRestoreFlag,
} = vi.hoisted(() => ({
  tokensGet: vi.fn<() => Session | null>(),
  finishLogin: vi.fn(),
  consumeReturnTo: vi.fn<() => string>(),
  startLogin: vi.fn(),
  logout: vi.fn(),
  consumeLogout: vi.fn(),
  isAudProbePending: vi.fn<() => boolean>(),
  finishAudProbe: vi.fn(),
  restoreSessionSilently: vi.fn(),
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
  finishAudProbe,
  restoreSessionSilently,
  consumeSilentRestoreFlag,
  startAudProbe: vi.fn(),
  takeProbeResult: vi.fn().mockReturnValue(null),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { routes } = await import("../src/router");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  consumeLogout.mockReturnValue({ handled: false, confirmed: false, cleanedSearch: "" });
  startLogin.mockResolvedValue(undefined);
  finishAudProbe.mockResolvedValue({ status: 401, expected: 401, aud: "x" });
  restoreSessionSilently.mockResolvedValue(undefined);
  isAudProbePending.mockReturnValue(false);
  consumeSilentRestoreFlag.mockReturnValue(false);
  tokensGet.mockReturnValue(null);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function renderAt(initialPath: string) {
  const router = createMemoryRouter(routes, { initialEntries: [initialPath] });
  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });
  return router;
}

describe("/callback — wrong-aud probe branch (Task 3)", () => {
  it("runs finishAudProbe then restoreSessionSilently, and never finishLogin", async () => {
    isAudProbePending.mockReturnValue(true);
    await renderAt("/callback?code=abc&state=s&iss=http://localhost:4000");
    expect(finishAudProbe).toHaveBeenCalledOnce();
    expect(restoreSessionSilently).toHaveBeenCalledOnce();
    expect(finishLogin).not.toHaveBeenCalled();
  });

  it("on a probe authorize error (?error) does ONE interactive login, no probe exchange", async () => {
    isAudProbePending.mockReturnValue(true);
    await renderAt("/callback?error=consent_required");
    expect(finishAudProbe).not.toHaveBeenCalled();
    expect(startLogin).toHaveBeenCalledWith("/api-test");
  });

  it("silent-restore callback: interaction_required (?error) => ONE interactive login, not /error", async () => {
    isAudProbePending.mockReturnValue(false);
    consumeSilentRestoreFlag.mockReturnValue(true);
    const router = await renderAt("/callback?error=interaction_required");
    expect(startLogin).toHaveBeenCalledWith("/api-test");
    // We did not redirect to the safe error page in this bounded fall-back.
    expect(router.state.location.pathname).not.toBe("/error");
  });

  it("ordinary login error (no silent-restore) still lands on the safe /error page", async () => {
    isAudProbePending.mockReturnValue(false);
    consumeSilentRestoreFlag.mockReturnValue(false);
    const router = await renderAt("/callback?error=access_denied");
    expect(startLogin).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe("/error");
    expect(router.state.location.search).toBe("?error=access_denied");
  });
});
