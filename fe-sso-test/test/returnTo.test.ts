// @vitest-environment node
import { describe, it, expect } from "vitest";
import { isSafeReturnTo, sanitizeReturnTo, DEFAULT_RETURN_TO } from "../src/returnTo";

const ORIGIN = "http://localhost:5173";

describe("returnTo validation (open-redirect defence, Task 2)", () => {
  describe("accepts safe same-origin internal paths", () => {
    const good = [
      "/",
      "/profile",
      "/tokens",
      "/api-test",
      "/profile?x=1",
      "/a/b/c?q=1&r=2",
      "/path#frag",
    ];
    for (const v of good) {
      it(`accepts ${JSON.stringify(v)}`, () => {
        expect(isSafeReturnTo(v, ORIGIN)).toBe(true);
        expect(sanitizeReturnTo(v, ORIGIN)).toBe(v);
      });
    }
  });

  describe("rejects unsafe candidates (fail-closed to `/`)", () => {
    const bad: Array<[string, unknown]> = [
      ["absolute https URL", "https://evil"],
      ["protocol-relative //", "//evil"],
      ["backslash host /\\", "/\\evil"],
      ["javascript scheme", "javascript:alert(1)"],
      ["data scheme", "data:text/html,x"],
      ["encoded double slash", "/%2F%2Fevil"],
      ["backslash anywhere", "/a\\b"],
      ["CR control char", "/a\r/b"],
      ["LF control char", "/a\n/b"],
      ["NUL control char", "/a\u0000b"],
      ["DEL control char", "/a\u007fb"],
      ["relative no slash", "profile"],
      ["empty string", ""],
      ["non-string null", null],
      ["non-string number", 42],
      ["non-string object", { toString: () => "/profile" }],
    ];
    for (const [name, v] of bad) {
      it(`rejects ${name}`, () => {
        expect(isSafeReturnTo(v, ORIGIN)).toBe(false);
        expect(sanitizeReturnTo(v, ORIGIN)).toBe(DEFAULT_RETURN_TO);
      });
    }
  });

  it("allows percent-encoding in the query portion (only the path is separator-checked)", () => {
    // `%2F` is fine inside a query value — the encoded-separator guard only inspects the path.
    expect(isSafeReturnTo("/search?q=a%2Fb", ORIGIN)).toBe(true);
  });

  it("falls back to the live origin when none is injected (no window -> reject)", () => {
    // In the node test env `window` is undefined, so a value that needs origin resolution with no
    // injected origin fails closed.
    expect(sanitizeReturnTo("/profile")).toBe(DEFAULT_RETURN_TO);
  });
});