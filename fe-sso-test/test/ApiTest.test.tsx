import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import type { Session } from "../src/oidc/tokenStore";
import type { ProbeResult } from "../src/oidc/probe";

const { tokensGet, startAudProbe, takeProbeResult } = vi.hoisted(() => ({
  tokensGet: vi.fn<() => Session | null>(),
  startAudProbe: vi.fn<() => Promise<void>>(),
  takeProbeResult: vi.fn<() => ProbeResult | null>(),
}));
const { callResource, ResourceNetworkError } = vi.hoisted(() => {
  class ResourceNetworkError extends Error {}
  return { callResource: vi.fn(), ResourceNetworkError };
});

vi.mock("../src/oidc/client", () => ({
  tokens: { get: tokensGet, set: vi.fn(), clear: vi.fn() },
  startAudProbe,
  takeProbeResult,
  demoApiUrl: () => "http://localhost:4000/demo/me",
  userinfoUrl: () => "http://localhost:4000/userinfo",
}));
vi.mock("../src/oidc/resourceCall", () => ({ callResource, ResourceNetworkError }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import ApiTest from "../src/routes/ApiTest";

const AT = "at-secret-should-never-render";
function session(): Session {
  return {
    accessToken: AT,
    idToken: "id",
    refreshToken: "rt",
    claims: { iss: "http://localhost:4000", sub: "user-9", aud: "fe-sso-test", exp: 0, iat: 0 },
    accessTokenExpiresAt: Date.now() + 90_000,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  tokensGet.mockReturnValue(session());
  takeProbeResult.mockReturnValue(null);
  startAudProbe.mockResolvedValue(undefined);
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
  act(() => root.render(<MemoryRouter><ApiTest /></MemoryRouter>));
}
function click(testid: string) {
  const el = container.querySelector(`[data-testid='${testid}']`) as HTMLButtonElement;
  return act(async () => {
    el.click();
  });
}
function q(testid: string) {
  return container.querySelector(`[data-testid='${testid}']`);
}

describe("/api-test — three checks, scored by expected status (INV-8)", () => {
  it("defensive fallback when reached without a session", () => {
    tokensGet.mockReturnValue(null);
    render();
    expect(q("api-test-actions")).toBeNull();
    expect(container.textContent).toContain("Not signed in");
  });

  it("Button A: /demo/me 200 => PASS, shows sub, Authorization header via callResource", async () => {
    callResource.mockResolvedValue({ status: 200, body: { sub: "user-9" } });
    render();
    await click("btn-demo");
    expect(callResource).toHaveBeenCalledWith("http://localhost:4000/demo/me", AT);
    expect(q("result-demo-verdict")?.textContent).toContain("PASS");
    expect(q("result-demo-sub")?.textContent).toContain("user-9");
  });

  it("Button A: non-200 => FAIL", async () => {
    callResource.mockResolvedValue({ status: 403, body: {} });
    render();
    await click("btn-demo");
    expect(q("result-demo-verdict")?.textContent).toContain("FAIL");
  });

  it("Button A: network error => FAIL 'network error', no crash", async () => {
    callResource.mockRejectedValue(new ResourceNetworkError("boom"));
    render();
    await click("btn-demo");
    expect(q("result-demo-verdict")?.textContent).toContain("FAIL");
    expect(q("result-demo-verdict")?.textContent).toContain("network error");
  });

  it("Button C: /userinfo 200 => PASS, calls the issuer's /userinfo", async () => {
    callResource.mockResolvedValue({ status: 200, body: { sub: "user-9" } });
    render();
    await click("btn-userinfo");
    expect(callResource).toHaveBeenCalledWith("http://localhost:4000/userinfo", AT);
    expect(q("result-userinfo-verdict")?.textContent).toContain("PASS");
  });

  it("Button B: triggers startAudProbe (redirect chain)", async () => {
    render();
    await click("btn-probe");
    expect(startAudProbe).toHaveBeenCalledOnce();
  });

  it("probe result 401 on mount => PASS with INV-8 explanation; result consumed one-shot", () => {
    takeProbeResult.mockReturnValue({
      status: 401,
      expected: 401,
      aud: "http://localhost:4000/other/",
    });
    render();
    expect(takeProbeResult).toHaveBeenCalledOnce();
    expect(q("result-probe-verdict")?.textContent).toContain("PASS");
    expect(q("result-probe-verdict")?.textContent).toContain("401");
    expect(q("result-probe-inv8")?.textContent).toContain("INV-8");
  });

  it("probe result non-401 => FAIL", () => {
    takeProbeResult.mockReturnValue({
      status: 200,
      expected: 401,
      aud: "http://localhost:4000/other/",
    });
    render();
    expect(q("result-probe-verdict")?.textContent).toContain("FAIL");
  });

  it("never renders the raw access token anywhere in the DOM", async () => {
    callResource.mockResolvedValue({ status: 200, body: { sub: "user-9" } });
    render();
    await click("btn-demo");
    await click("btn-userinfo");
    expect(container.innerHTML).not.toContain(AT);
  });
});
