// @vitest-environment node
// Run 46 tester: FE vs BE parity of the resource rules. The `be` column was MEASURED (not assumed)
// by running the real BE validators on this corpus: `validateSync(plainToInstance(CreateResourceDto /
// UpdateResourceDto, body), { whitelist: true, forbidNonWhitelisted: true })` then
// `validateResourceFormat(identifier)` (be/src/modules/admin/admin.dto.ts,
// be/src/modules/resources/resource.validator.ts). If either side changes, re-measure.
// Invariant: the form NEVER accepts what the BE refuses; every divergence is FE-stricter and listed.
import { describe, expect, it } from "vitest";
import { EditResourceSchema, NewResourceSchema, identifierProblem } from "@/features/resources/resource-form-schema";
import { CreateResourceInput, UpdateResourceInput } from "@/features/admin-api/inputs";

const x = (n: number) => "x".repeat(n);
const E = "\u{1F600}"; // astral: 2 UTF-16 units, 1 for the BE `isLength`

/** [identifier, BE accepts, form accepts] */
const IDENTIFIERS: [string, boolean, boolean][] = [
  ["https://api.example.com/", true, true],
  ["urn:example:api", true, true],
  ["urn:", true, true],
  ["a:", true, true],
  ["https://a/#", true, true], // empty fragment => hash === ""
  ["https://a/?#", true, true],
  ["https://a/%23", true, true],
  ["https://a/#x", false, false],
  ["javascript:alert(1)", true, true],
  ["data:text/html,<b>x</b>", true, true],
  ["file:///etc/passwd", true, true],
  ["https://[::1]/", true, true],
  ["https://ä.example/", true, true],
  ["HTTPS://A/", true, true],
  ["https://a/ b", true, true],
  ["https:", false, false],
  ["https://", false, false],
  ["http://a b/", false, false],
  ["api.example.com", false, false],
  ["/relative", false, false],
  ["", false, false],
  [" ", false, false],
  // FE-stricter (approved trim rule, DEBT-324): `new URL` drops them, the BE stores the raw string.
  [" https://a/", true, false],
  ["https://a/ ", true, false],
  ["\thttps://a/", true, false],
  ["https://a/\t", true, false],
  ["https://a/ ", true, false],
  ["https://a/﻿", true, false],
  ["https://a/ ", true, false],
  // Same gap on both sides (DEBT-329): `new URL` strips C0 controls at the ends and tab/LF anywhere,
  // `trim()` does not cover U+0000 and nothing checks inside => raw stored != parsed URL.
  ["\u0000https://a/", true, true],
  ["https://a/\u0000", true, true],
  ["https://a/b\tc", true, true],
  ["https://a/b\nc", true, true],
  ["https://a/​", true, true],
  // Length: BE counts code points, FE counts UTF-16 units (FE-stricter for astral characters only).
  [`https://a/${x(2038)}`, true, true], // 2048
  [`https://a/${x(2039)}`, false, false], // 2049
  [`https://a/${x(2036)}${E}`, true, true], // 2048 units
  [`https://a/${x(2037)}${E}`, true, false], // 2049 units, 2048 code points
  [`https://a/${E.repeat(1020)}`, true, false], // 2050 units, 1030 code points
];

const show = (v: string) => JSON.stringify(v.length > 40 ? `${v.slice(0, 12)}…(${v.length})` : v);

describe("identifier: form vs measured BE verdict", () => {
  it.each(IDENTIFIERS.map(([v, be, fe]) => [show(v), v, be, fe] as const))("%s", (_, v, be, fe) => {
    expect(identifierProblem(v) === null).toBe(fe);
    expect(NewResourceSchema.safeParse({ resourceId: "demo", identifier: v, scopes: "" }).success).toBe(fe);
    if (fe) expect(be).toBe(true); // never accept what the BE refuses
  });

  it("the server fn input only bounds the length (the BE enforces the URI rules)", () => {
    expect(CreateResourceInput.safeParse({ resourceId: "demo", identifier: "https://a/#x", scopes: [] }).success).toBe(true);
    expect(CreateResourceInput.safeParse({ resourceId: "demo", identifier: x(2049), scopes: [] }).success).toBe(false);
    expect(CreateResourceInput.safeParse({ resourceId: "demo", identifier: "", scopes: [] }).success).toBe(false);
  });
});

/** [resourceId, BE accepts] — form and server fn agree with the BE on all of them. */
const RESOURCE_IDS: [string, boolean][] = [
  ["a", true],
  ["0", true],
  ["9z", true],
  [`a${x(63)}`, true], // 64
  [`a${x(64)}`, false], // 65
  ["a..b", true],
  ["a-", true],
  ["a.", true],
  ["-a", false],
  [".a", false],
  ["_a", false],
  ["A", false],
  ["aB", false],
  ["a b", false],
  ["a\n", false], // `$` is end-of-input (no m flag) on both sides
  ["a\nb", false],
  ["é", false],
  ["a/b", false],
  ["", false],
];

describe("resourceId: form + server fn vs measured BE verdict", () => {
  it.each(RESOURCE_IDS.map(([v, be]) => [JSON.stringify(v), v, be] as const))("%s", (_, v, be) => {
    expect(NewResourceSchema.safeParse({ resourceId: v, identifier: "https://a/", scopes: "" }).success).toBe(be);
    expect(CreateResourceInput.safeParse({ resourceId: v, identifier: "https://a/", scopes: [] }).success).toBe(be);
  });
});

describe("scopes: server fn vs measured BE verdict; form output never refused by the BE", () => {
  const n = (count: number) => Array.from({ length: count }, (_, i) => `s${i}`);
  /** [list, BE accepts, form output (null = blocked) for `list.join(" ")`] */
  const LISTS: [string, string[], boolean, string[] | null][] = [
    ["[]", [], true, []],
    ["50", n(50), true, n(50)],
    ["51", n(51), false, null],
    ["256 chars", [x(256)], true, [x(256)]],
    ["257 chars", [x(257)], false, null],
    ["128 astral (256 units)", [E.repeat(128)], true, [E.repeat(128)]],
    ["129 astral (258 units): FE-stricter", [E.repeat(129)], true, null],
    ["duplicate: FE-stricter", ["a", "a"], true, null],
    ["zero-width space inside (not \\s)", ["a​b"], true, ["a​b"]],
  ];
  it.each(LISTS)("%s", (_, list, be, form) => {
    const parsed = EditResourceSchema.safeParse({ scopes: list.join(" ") });
    expect(parsed.success ? parsed.data.scopes : null).toEqual(form);
    if (form) {
      expect(be).toBe(true);
      expect(UpdateResourceInput.safeParse({ resourceId: "a", patch: { scopes: form } }).success).toBe(true);
    }
  });

  it.each([
    ["NBSP", "a b"],
    ["tab", "a\tb"],
    ["ideographic space", "a　b"],
    ["line separator", "a b"],
  ])("%s inside a token: the BE refuses it; the form splits it (two tokens), the server fn refuses it", (_, token) => {
    expect(EditResourceSchema.parse({ scopes: token }).scopes).toEqual(["a", "b"]);
    expect(UpdateResourceInput.safeParse({ resourceId: "a", patch: { scopes: [token] } }).success).toBe(false);
  });

  it("an empty token is refused by the server fn (the BE refuses it); the form drops it", () => {
    expect(UpdateResourceInput.safeParse({ resourceId: "a", patch: { scopes: [""] } }).success).toBe(false);
    expect(EditResourceSchema.parse({ scopes: " \n\t " }).scopes).toEqual([]);
  });

  it("PATCH with identifier / resourceId / no scopes: the BE refuses (measured); the server fn too", () => {
    for (const patch of [{ scopes: [], identifier: "https://a/" }, { scopes: [], resourceId: "a" }, {}]) {
      expect(UpdateResourceInput.safeParse({ resourceId: "a", patch }).success).toBe(false);
    }
  });
});
