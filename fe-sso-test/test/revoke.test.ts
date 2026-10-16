// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { revokeRefreshToken } from "../src/oidc/revoke";

const ENDPOINT = "http://localhost:4000/revoke";
const RT = "rt-secret-must-not-leak";
const CLIENT = "fe-sso-test";

function captureFetch(response: Response | (() => Promise<Response>)) {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return typeof response === "function" ? response() : response;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe("revokeRefreshToken — best-effort (RFC 7009), token only in the body", () => {
  it("POSTs token + token_type_hint + client_id as form body and returns true on 200", async () => {
    const { fn, calls } = captureFetch(new Response("{}", { status: 200 }));
    const ok = await revokeRefreshToken(ENDPOINT, RT, CLIENT, fn);
    expect(ok).toBe(true);
    const init = calls[0].init!;
    expect(init.method).toBe("POST");
    const body = String(init.body);
    const params = new URLSearchParams(body);
    expect(params.get("token")).toBe(RT);
    expect(params.get("token_type_hint")).toBe("refresh_token");
    expect(params.get("client_id")).toBe(CLIENT);
    // The refresh token must never appear in the request URL.
    expect(String(calls[0].input)).not.toContain(RT);
  });

  it("returns false (swallowed) on a non-2xx — best-effort, never blocks the probe", async () => {
    const { fn } = captureFetch(new Response("{}", { status: 400 }));
    await expect(revokeRefreshToken(ENDPOINT, RT, CLIENT, fn)).resolves.toBe(false);
  });

  it("returns false (swallowed) on a thrown network/CORS error", async () => {
    const { fn } = captureFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(revokeRefreshToken(ENDPOINT, RT, CLIENT, fn)).resolves.toBe(false);
  });
});
