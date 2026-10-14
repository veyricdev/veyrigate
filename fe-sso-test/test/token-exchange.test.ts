// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { postToken } from "../src/oidc/token-exchange";
import { discovery, tokenResponse } from "./helpers/env";

const body = { grant_type: "authorization_code", code: "abc" };

describe("postToken success-shape validation", () => {
  it("parses a well-formed success response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      tokenResponse({ access_token: "at", token_type: "Bearer", expires_in: 900, scope: "openid" }),
    );
    const res = await postToken(discovery.token_endpoint, body, fetchImpl as unknown as typeof fetch);
    expect(res.access_token).toBe("at");
    expect(res.expires_in).toBe(900);
  });

  it("rejects a 2xx response missing access_token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      tokenResponse({ token_type: "Bearer", expires_in: 900 }),
    );
    await expect(
      postToken(discovery.token_endpoint, body, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/malformed/);
  });

  it("rejects a 2xx response whose expires_in is not a number", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      tokenResponse({ access_token: "at", token_type: "Bearer", expires_in: "soon" }),
    );
    await expect(
      postToken(discovery.token_endpoint, body, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/malformed/);
  });

  it("rejects a 2xx response with a non-bearer token_type", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      tokenResponse({ access_token: "at", token_type: "mac", expires_in: 900 }),
    );
    await expect(
      postToken(discovery.token_endpoint, body, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/malformed/);
  });

  it("still surfaces a non-2xx OAuth error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      tokenResponse({ error: "invalid_grant" }, 400),
    );
    await expect(
      postToken(discovery.token_endpoint, body, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/invalid_grant/);
  });
});