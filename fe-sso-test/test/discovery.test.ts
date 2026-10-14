// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { discover } from "../src/oidc/discovery";

const ISSUER = "http://localhost:4000";

function fullDoc(overrides: Record<string, unknown> = {}) {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/jwks.json`,
    end_session_endpoint: `${ISSUER}/logout`,
    userinfo_endpoint: `${ISSUER}/userinfo`,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("discover", () => {
  it("parses a valid document and requires the core endpoints", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(fullDoc()));
    const d = await discover(ISSUER, fetchImpl as unknown as typeof fetch);
    expect(d.authorization_endpoint).toBe(`${ISSUER}/authorize`);
    expect(d.token_endpoint).toBe(`${ISSUER}/token`);
    expect(d.jwks_uri).toBe(`${ISSUER}/jwks.json`);
    expect(d.end_session_endpoint).toBe(`${ISSUER}/logout`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a required endpoint is missing", async () => {
    const { token_endpoint: _t, ...partial } = fullDoc();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(partial));
    await expect(discover(ISSUER, fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /token_endpoint/,
    );
  });

  it("rejects an issuer mismatch (mix-up defence, F5)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(fullDoc({ issuer: "http://evil.example" })));
    await expect(discover(ISSUER, fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /issuer mismatch/i,
    );
  });

  it("maps an aborted (timed-out) fetch to a clear timeout error (F6)", async () => {
    // Simulate what AbortSignal.timeout triggers: fetch rejects with a TimeoutError
    // DOMException. discover() must surface a readable "timed out" message, fail-closed.
    const fetchImpl = vi.fn().mockRejectedValue(new DOMException("aborted", "TimeoutError"));
    await expect(discover(ISSUER, fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /timed out/i,
    );
  });

  it("passes an AbortSignal so every discovery fetch is time-boxed (F6)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(fullDoc()));
    await discover(ISSUER, fetchImpl as unknown as typeof fetch);
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
