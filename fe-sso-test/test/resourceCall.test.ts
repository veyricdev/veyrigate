// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { callResource, ResourceNetworkError } from "../src/oidc/resourceCall";

const URL_ = "http://localhost:4000/demo/me";
const AT = "at-secret-must-not-leak";

/** A fetch mock that captures the (input, init) it was called with. */
function captureFetch(response: Response) {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return response;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("callResource — Bearer, no cookies, status-scored (INV-8, exposure budget)", () => {
  it("sends Authorization: Bearer <token> and returns status + JSON body on 200", async () => {
    const { fn, calls } = captureFetch(json({ sub: "user-9" }, 200));
    const res = await callResource(URL_, AT, fn);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sub: "user-9" });
    const init = calls[0].init!;
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${AT}`);
  });

  it("uses credentials:'omit' and cache:'no-store' (no ambient cookies, no stale decision)", async () => {
    const { fn, calls } = captureFetch(json({}, 200));
    await callResource(URL_, AT, fn);
    const init = calls[0].init!;
    expect(init.credentials).toBe("omit");
    expect(init.cache).toBe("no-store");
    expect(init.method).toBe("GET");
  });

  it("the token never appears in the request URL (only the header)", async () => {
    const { fn, calls } = captureFetch(json({}, 200));
    await callResource(URL_, AT, fn);
    expect(String(calls[0].input)).toBe(URL_);
    expect(String(calls[0].input)).not.toContain(AT);
  });

  it("resolves with the status for a 401 (no throw — caller scores it)", async () => {
    const { fn } = captureFetch(json({ error: "invalid_token" }, 401));
    const res = await callResource(URL_, AT, fn);
    expect(res.status).toBe(401);
  });

  it("maps a network/CORS failure (fetch rejects with TypeError) to ResourceNetworkError", async () => {
    const fn = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(callResource(URL_, AT, fn)).rejects.toBeInstanceOf(ResourceNetworkError);
  });

  it("maps a timeout (AbortSignal.timeout) to ResourceNetworkError", async () => {
    const fn = vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    }) as unknown as typeof fetch;
    await expect(callResource(URL_, AT, fn)).rejects.toBeInstanceOf(ResourceNetworkError);
  });

  it("returns body:null when the response has no JSON body", async () => {
    const { fn } = captureFetch(new Response("", { status: 200 }));
    const res = await callResource(URL_, AT, fn);
    expect(res.body).toBeNull();
  });
});
