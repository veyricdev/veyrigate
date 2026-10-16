// @vitest-environment node
import { describe, it, expect } from "vitest";
import { describeOAuthError } from "../src/oidc/oauthError";

describe("describeOAuthError (DEBT-080: never echo error_description)", () => {
  it("maps a recognised code to its safe fixed message", () => {
    const r = describeOAuthError("access_denied");
    expect(r.code).toBe("access_denied");
    expect(r.message).toBe("Sign-in was denied.");
  });

  it("maps other known codes", () => {
    expect(describeOAuthError("server_error").code).toBe("server_error");
    expect(describeOAuthError("login_required").message).toBe("You need to sign in again.");
  });

  it("collapses an unknown code to a generic unknown_error", () => {
    const r = describeOAuthError("totally_made_up");
    expect(r.code).toBe("unknown_error");
    expect(r.message).toBe("Sign-in failed.");
  });

  it("rejects malformed/injection-shaped codes (not a-z_)", () => {
    for (const bad of ["<script>", "access denied", "ACCESS_DENIED", "a1", "", "access_denied;x"]) {
      const r = describeOAuthError(bad);
      expect(r.code).toBe("unknown_error");
    }
  });

  it("handles null/undefined", () => {
    expect(describeOAuthError(null).code).toBe("unknown_error");
    expect(describeOAuthError(undefined).code).toBe("unknown_error");
  });

  it("never returns a message containing HTML/script payloads from the input", () => {
    const payload = "access_denied<img src=x onerror=alert(1)>";
    const r = describeOAuthError(payload);
    expect(r.code).toBe("unknown_error");
    expect(r.message).not.toContain("<");
    expect(r.message).not.toContain("onerror");
  });
});