// @vitest-environment node
// getViewer server function: a cleared session cookie is APPENDED to the response, never replacing
// a Set-Cookie another part of the request already wrote (DEBT-287).
import { describe, expect, it, vi } from "vitest";

const responseHeaders = new Headers();
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({ handler: (fn: () => unknown) => fn }),
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("http://localhost:3000/"),
  getResponseHeaders: () => responseHeaders,
}));
vi.mock("@/server/auth/instance", () => ({
  getAuth: () => ({ viewer: async () => ({ viewer: null, setCookie: "fea_sid=; Path=/; Max-Age=0" }) }),
}));

const { getViewer } = await import("@/features/auth/viewer");

describe("getViewer", () => {
  it("appends the session-clearing cookie next to an existing Set-Cookie", async () => {
    responseHeaders.append("set-cookie", "fea_theme=dark; Path=/");
    expect(await (getViewer as unknown as () => Promise<unknown>)()).toBeNull();
    expect(responseHeaders.getSetCookie()).toEqual(["fea_theme=dark; Path=/", "fea_sid=; Path=/; Max-Age=0"]);
  });
});
