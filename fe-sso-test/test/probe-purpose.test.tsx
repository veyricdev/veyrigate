import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";

/**
 * QA (run 24 tester) — Task 3 acceptance: "Callback with an unknown/missing `purpose` => handled
 * as an ordinary login, never calls /demo/me". `router-probe.test.tsx` mocks `isAudProbePending`
 * itself, so the purpose-parsing was never exercised. Here the REAL `isAudProbePending` reads the
 * REAL sessionStorage transient; only the network-bound finishers are stubbed.
 */
const { finishLogin, finishAudProbe, restoreSessionSilently, fetchSpy } = vi.hoisted(() => ({
  finishLogin: vi.fn(),
  finishAudProbe: vi.fn(),
  restoreSessionSilently: vi.fn(),
  fetchSpy: vi.fn(),
}));

vi.mock("../src/env.app", () => ({
  env: {
    VITE_OIDC_ISSUER: "http://localhost:4000",
    VITE_OIDC_CLIENT_ID: "fe-sso-test",
    VITE_OIDC_REDIRECT_URI: "http://localhost:5173/callback",
    VITE_OIDC_POST_LOGOUT_URI: "http://localhost:5173/",
    VITE_OIDC_SCOPE: "openid profile email offline_access",
    VITE_OIDC_RESOURCE: "http://localhost:4000/demo/",
    VITE_DEMO_API_URL: "http://localhost:4000",
  },
}));

vi.mock("../src/oidc/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/oidc/client")>();
  return { ...real, finishLogin, finishAudProbe, restoreSessionSilently };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { isAudProbePending } = await import("../src/oidc/client");
const { routes } = await import("../src/router");

const base = { state: "s", nonce: "n", verifier: "v", createdAt: Date.now() };
const put = (v: unknown) =>
  window.sessionStorage.setItem("oidc:transient", typeof v === "string" ? v : JSON.stringify(v));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.sessionStorage.clear();
  finishLogin.mockResolvedValue(undefined);
  finishAudProbe.mockResolvedValue({ status: 401, expected: 401, aud: "x" });
  restoreSessionSilently.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", fetchSpy);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.sessionStorage.clear();
});

describe("isAudProbePending — only the exact 'aud-probe' purpose triggers the probe (fail-closed)", () => {
  const cases: Array<[string, unknown, boolean]> = [
    ["no transient", undefined, false],
    ["purpose missing", base, false],
    ["purpose 'login'", { ...base, purpose: "login" }, false],
    ["unknown purpose", { ...base, purpose: "evil" }, false],
    ["case-variant purpose", { ...base, purpose: "AUD-PROBE" }, false],
    ["non-string purpose", { ...base, purpose: ["aud-probe"] }, false],
    ["malformed JSON", "{not json", false],
    ["aud-probe but structurally invalid transient", { purpose: "aud-probe" }, false],
    ["valid aud-probe", { ...base, purpose: "aud-probe" }, true],
  ];
  it.each(cases)("%s", (_name, value, expected) => {
    if (value !== undefined) put(value);
    expect(isAudProbePending()).toBe(expected);
  });
});

describe("/callback with an unknown/missing purpose => ordinary login, never the probe", () => {
  it.each([
    ["missing", base],
    ["unknown", { ...base, purpose: "evil" }],
  ])("purpose %s: finishLogin runs; finishAudProbe / silent restore / any fetch do not", async (_n, t) => {
    put(t);
    const router = createMemoryRouter(routes, {
      initialEntries: ["/callback?code=abc&state=s&iss=http://localhost:4000"],
    });
    await act(async () => {
      root.render(<RouterProvider router={router} />);
    });
    expect(finishLogin).toHaveBeenCalledOnce();
    expect(finishAudProbe).not.toHaveBeenCalled();
    expect(restoreSessionSilently).not.toHaveBeenCalled();
    // No direct network call from the router itself (in particular no /demo/me).
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
