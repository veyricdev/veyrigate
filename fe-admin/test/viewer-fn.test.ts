// @vitest-environment node
// getViewer server function: a cleared session cookie is APPENDED to the response through Start's
// `appendResponseHeader` (never `setResponseHeader`, which would replace a Set-Cookie another part of
// the request already wrote, DEBT-287). The runtime behaviour is locked by E2E fe-admin-risk (D101.6).
import { describe, expect, it, vi } from "vitest";

const appendHeader = vi.fn();
const setHeader = vi.fn();
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({ handler: (fn: () => unknown) => fn }),
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("http://localhost:3000/"),
  appendResponseHeader: appendHeader,
  setResponseHeader: setHeader,
}));
vi.mock("@/server/auth/instance", () => ({
  getAuth: () => ({ viewer: async () => ({ viewer: null, setCookie: "fea_sid=; Path=/; Max-Age=0" }) }),
}));

const { getViewer } = await import("@/features/auth/viewer");

describe("getViewer", () => {
  it("appends the session-clearing cookie (append, never set)", async () => {
    expect(await (getViewer as unknown as () => Promise<unknown>)()).toBeNull();
    expect(appendHeader).toHaveBeenCalledTimes(1);
    expect(appendHeader).toHaveBeenCalledWith("set-cookie", "fea_sid=; Path=/; Max-Age=0");
    expect(setHeader).not.toHaveBeenCalled();
  });
});
