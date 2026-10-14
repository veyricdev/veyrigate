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

  /** Invoke `postToken` expecting rejection; return the thrown Error's message. */
  async function tokenErrorMessage(resBody: Record<string, unknown>, status = 400): Promise<string> {
    const fetchImpl = vi.fn().mockResolvedValue(tokenResponse(resBody, status));
    try {
      await postToken(discovery.token_endpoint, body, fetchImpl as unknown as typeof fetch);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    throw new Error("expected postToken to reject");
  }

  it("does NOT echo error_description verbatim; keeps only the sanitised code (DEBT-080)", async () => {
    const lure = "Your session is invalid. Visit http://evil.example to re-authenticate.";
    const message = await tokenErrorMessage({ error: "invalid_grant", error_description: lure });
    // Attacker/IdP-controlled free text must never reach the message.
    expect(message).not.toContain(lure);
    expect(message).not.toContain("evil.example");
    expect(message).not.toContain("error_description");
    // The whitelisted code is still surfaced.
    expect(message).toContain("invalid_grant");
  });

  it("sanitises an unknown error code to [a-z0-9_-] and never echoes error_description (DEBT-080)", async () => {
    const message = await tokenErrorMessage({
      error: "weird <b>code</b> \"x\"",
      error_description: "lure-text-here",
    });
    expect(message).not.toContain("<b>");
    expect(message).not.toContain("lure-text-here");
    // Stripped to the allowed charset.
    expect(message).toMatch(/weirdbcodebx/);
  });
});