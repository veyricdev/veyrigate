import { describe, expect, it } from "vitest";
import { parseTheme, themeClass } from "@/features/theme/theme";

describe("parseTheme", () => {
  it("accepts the whitelisted values", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("system")).toBe("system");
  });

  it("falls back to system for anything else", () => {
    for (const v of [undefined, "", "Dark", "dark ", "evil\"><script>", "light;dark"]) {
      expect(parseTheme(v)).toBe("system");
    }
  });

  it("maps system to no <html> class", () => {
    expect(themeClass("system")).toBeUndefined();
    expect(themeClass("dark")).toBe("dark");
  });
});

// Tester (run 41): hostile/odd cookie values (prototype keys, encoded payloads, non-strings).
describe("parseTheme — hostile cookie values", () => {
  it.each([
    '"><script>alert(1)</script>',
    "%22%3E%3Cscript%3E",
    "dark%20onload=alert(1)",
    "__proto__",
    "constructor",
    "toString",
    "DARK",
    "dark\u0000",
    "x".repeat(4096),
  ])("%s => system", (v) => {
    expect(parseTheme(v)).toBe("system");
  });

  it.each([null, 1, true, {}, ["dark"], { toString: () => "dark" }])("non-string %s => system", (v) => {
    expect(parseTheme(v)).toBe("system");
  });
});
