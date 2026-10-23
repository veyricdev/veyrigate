// @vitest-environment node
// Run 46 F3 / Q-46.1: the resource form rules mirror the BE (`CreateResourceDto`,
// `UpdateResourceDto`, `validateResourceFormat`), plus the approved trim rule (DEBT-324) and
// duplicate scopes. Table-driven: what passes / what is blocked.
import { describe, expect, it } from "vitest";
import {
  EditResourceSchema,
  NewResourceSchema,
  identifierProblem,
  sameScopes,
} from "@/features/resources/resource-form-schema";

const NEW = { resourceId: "demo", identifier: "https://api.example.com/", scopes: "" };
const issues = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? [] : r.error!.issues.map((i) => i.message);

describe("identifier (BE: ≤ 2048, new URL, empty hash; FE: + no leading/trailing space)", () => {
  it.each([
    "https://api.example.com/",
    "urn:example:api",
    "https://a/#", // empty fragment: hash === "" (same as the BE)
    "http://localhost:4100/",
    "javascript:alert(1)", // the BE accepts any scheme: rendered as text only
    "https://*.example.com/",
    `https://a/${"x".repeat(2038)}`, // 2048
  ])("passes %j", (v) => {
    expect(identifierProblem(v)).toBeNull();
    expect(NewResourceSchema.safeParse({ ...NEW, identifier: v }).success).toBe(true);
  });

  it.each([
    ["", "Required"],
    [" https://a/", "Remove leading/trailing spaces"],
    ["https://a/ ", "Remove leading/trailing spaces"],
    ["https://a/\n", "Remove leading/trailing spaces"],
    ["api.example.com", "Must be an absolute URI"],
    ["/relative", "Must be an absolute URI"],
    ["https://a/#x", "Must not contain a fragment"],
    [`https://a/${"x".repeat(2039)}`, "Must be at most 2048 characters"], // 2049
  ])("blocks %j: %s", (v, message) => {
    expect(identifierProblem(v)).toBe(message);
    expect(issues(NewResourceSchema.safeParse({ ...NEW, identifier: v }))).toEqual([message]);
  });
});

describe("resourceId (BE ^[a-z0-9][a-z0-9._-]{0,63}$)", () => {
  it.each(["a", "0", "demo", "my.api_v2-x", `a${"b".repeat(63)}`])("passes %j", (resourceId) => {
    expect(NewResourceSchema.safeParse({ ...NEW, resourceId }).success).toBe(true);
  });
  it.each(["", "Demo", "-a", ".a", "_a", "a b", "a/b", "é", `a${"b".repeat(64)}`])("blocks %j", (resourceId) => {
    expect(NewResourceSchema.safeParse({ ...NEW, resourceId }).success).toBe(false);
  });
});

describe("scopes (resource: ≤ 50, each ≤ 256, no whitespace, no duplicate; NOT the client 20/2048)", () => {
  const n = (count: number) => Array.from({ length: count }, (_, i) => `s${i}`).join(" ");

  it("split on spaces and new lines; output is the list", () => {
    expect(EditResourceSchema.parse({ scopes: " read\nwrite \t admin " })).toEqual({ scopes: ["read", "write", "admin"] });
  });
  it("empty is valid (create and edit)", () => {
    expect(EditResourceSchema.parse({ scopes: "" })).toEqual({ scopes: [] });
    expect(NewResourceSchema.parse(NEW).scopes).toEqual([]);
  });
  it("50 passes, 51 blocked", () => {
    expect(EditResourceSchema.safeParse({ scopes: n(50) }).success).toBe(true);
    expect(issues(EditResourceSchema.safeParse({ scopes: n(51) }))).toEqual(["At most 50 scopes"]);
  });
  it("256 chars passes, 257 blocked", () => {
    expect(EditResourceSchema.safeParse({ scopes: "s".repeat(256) }).success).toBe(true);
    expect(issues(EditResourceSchema.safeParse({ scopes: "s".repeat(257) }))).toEqual(["A scope must be at most 256 characters"]);
  });
  it("duplicate blocked", () => {
    expect(issues(EditResourceSchema.safeParse({ scopes: "read write read" }))).toEqual(['"read" is listed twice']);
  });
  it("sameScopes compares the token lists in order", () => {
    expect(sameScopes("a b", " a\nb ")).toBe(true);
    expect(sameScopes("a b", "b a")).toBe(false);
    expect(sameScopes("", " ")).toBe(true);
  });
});
